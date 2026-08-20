// Per-document memos for the three whole-document scans, so one keystroke pays for each of them
// once instead of once per caller.
//
// Every editor surface derives its state from a full walk of the note: the inline-eval plugin scans
// for spans, the inlay plugin locates fenced blocks, and both read the frontmatter body to derive
// the note preamble. Individually each is a linear pass and unremarkable, but together they became
// quite expensive when run on every keystroke.
//
// CodeMirror provides the key to the fix: a `Text` is immutable and shared across the states
// derived from it, so "the same `Text`" *is* "the same document". There is no staleness window to
// reason about and no invalidation to get wrong, so an edit produces a new `Text` which misses, so
// we can build this as a `WeakMap` with no eviction policy.
//
// The memo is deliberately not incremental. {@link numbatFenceState} (document/fence-state.ts) is
// the incremental index, and it answers a narrower question by recomputing only when an edit could
// have moved a fence. This module is the complement: it holds the full results, and gets its
// cheapness from repetition within a keystroke rather than from reuse across one.
//
// Results are shared, not copied, so **callers must treat them as immutable**. Every consumer today
// only reads or `map`s, and the producing functions build fresh arrays per call, so nothing had to
// change to make that true — but it is now load-bearing rather than incidental.
//
// On the imports: this is the one module in `document/` that reaches into `evaluation/` and
// `properties/` rather than only downward. That is deliberate — it memoizes the three scans as a
// set, and splitting it into three modules beside their scanners would buy layering purity with
// three `WeakMap` lookups where one will do. It stays honest about the rule that is actually
// enforced (docs/architecture.md): everything it touches is pure, so this module needs neither
// Obsidian nor CodeMirror and is testable under plain Node.

import { type InlineEvalConfig, type NoteUnit, scanNote } from "../evaluation/inline-parse";
import { frontmatterBody } from "../properties/parse";
import { type NumbatBlockRange, numbatBlockRanges } from "./fences";

/**
 * The document shape these scans need. Structurally typed rather than taking a CM6 `Text` — the
 * same trick {@link numbatFenceState}'s scan uses — so the tests can drive this with a plain
 * object, which a `WeakMap` accepts as a key just as happily.
 *
 * `iterLines` is the O(n) sequential cursor, as opposed to `line(n)`'s per-call B-tree descent.
 */
export interface ScannedDoc {
  lines: number;
  iterLines: (from: number, to: number) => Iterable<string>;
}

/**
 * What has been computed for one document so far. Each field is filled on first ask.
 *
 * `body` needs `bodyComputed` beside it because `null` is a *result* — a note with no frontmatter —
 * and not a miss. Without the flag, every such note would rescan on every call, which is the case
 * this module most wants to make cheap.
 */
interface DocMemo {
  blocks: NumbatBlockRange[] | null;
  body: string[] | null;
  bodyComputed: boolean;
  note: { stamp: string; units: NoteUnit[]; } | null;
}

const memos = new WeakMap<ScannedDoc, DocMemo>();

/** This document's memo, created empty on first use. */
function memoFor(doc: ScannedDoc): DocMemo {
  const existing = memos.get(doc);
  if (existing !== undefined) {
    return existing;
  }

  const fresh: DocMemo = { blocks: null, body: null, bodyComputed: false, note: null };
  memos.set(doc, fresh);
  return fresh;
}

/** Every line of `doc`, in order — what all three scans consume. */
function allLines(doc: ScannedDoc): Iterable<string> {
  return doc.iterLines(1, doc.lines + 1);
}

/**
 * {@link numbatBlockRanges} over a whole document, memoized.
 *
 * Prefer {@link numbatFenceState} when block *extents* are all you need — it survives a keystroke,
 * where this only survives the calls made about one. Use this when you need the bodies.
 */
export function blockRangesOf(doc: ScannedDoc): NumbatBlockRange[] {
  const memo = memoFor(doc);
  memo.blocks ??= numbatBlockRanges(allLines(doc));
  return memo.blocks;
}

/** {@link frontmatterBody} over a whole document, memoized. `null` when the note has none. */
export function frontmatterBodyOf(doc: ScannedDoc): string[] | null {
  const memo = memoFor(doc);
  if (!memo.bodyComputed) {
    memo.body = frontmatterBody(allLines(doc));
    memo.bodyComputed = true;
  }

  return memo.body;
}

/**
 * {@link scanNote} over a whole document, memoized per document *and* configuration.
 *
 * A single slot rather than a map keyed by configuration: the prefixes and separator come from
 * settings, so within the lifetime of one `Text` they are the same on every call but for the
 * keystroke that changes them in the settings tab.
 */
export function scannedNote(doc: ScannedDoc, config: InlineEvalConfig): NoteUnit[] {
  const memo = memoFor(doc);
  const stamp = configStamp(config);
  if (memo.note === null || memo.note.stamp !== stamp) {
    memo.note = { stamp, units: scanNote(allLines(doc), config) };
  }

  return memo.note.units;
}

/**
 * A configuration's identity for {@link scannedNote}.
 *
 * Deliberately the *whole* configuration, not the subset scanning currently reads: this describes
 * the input, so a scan that grows a dependency on `decimalPlaces` tomorrow cannot silently serve a
 * stale answer today. The cost of the extra fields is one settings change re-scanning once.
 */
function configStamp(config: InlineEvalConfig): string {
  return [
    config.live,
    config.concrete,
    config.separator,
    config.frontmatter ? "1" : "0",
    config.codeBlocks ? "1" : "0",
    config.decimalPlaces ?? "",
    // NUL, not a space: the prefixes and the separator are user-set and may contain anything.
  ].join("\0");
}
