// What survives a restart of the prelude's own vocabulary, and the check that decides whether it
// still stands.
//
// The names Numbat's prelude defines (properties/note.ts) decide how a note's frontmatter reads: a
// property called `m` must not shadow the metre, or `5 m` in a sibling property silently becomes
// arithmetic. Building that set needs an interpreter, so until one exists nothing reads as
// reserved. When the set finally arrives it moves `reservedEpoch`, which every preamble cache key
// folds in, so every open note re-derives.
//
// That is one storm per session today, and one *plus a round trip* once the interpreter is behind a
// worker. So the set is written into the plugin's data beside the settings and read back
// synchronously at load, which turns a per-session storm into a per-prelude-change one.
//
// **The seed is provisional, and that is what makes a cheap key safe.** The key below covers the
// plugin version (which pins the bundled Numbat), the prelude files and the exchange-rate flag, but
// *not* the contents of those files, which are not read from the vault until later. A prelude
// edited while the vault was closed therefore seeds a set that is subtly wrong. It is corrected by
// the very next thing that happens: the interpreter builds the real set, sees that it differs, and
// bumps the epoch to avoid a re-evaluation storm.
//
// Imports one pure helper, so it loads under plain `node --test`.

import { digest } from "./parse";

/** A persisted reserved-name set. Plain data, so it round-trips through `data.json` unchanged. */
export interface ReservedNamesRecord {
  /** What the set was built from — see {@link reservedNamesKey}. A record whose key no longer
   *  matches is discarded rather than migrated: rebuilding it costs one evaluation. */
  readonly key: string;

  /** The names themselves. */
  readonly names: readonly string[];
}

/**
 * What a reserved-name set depends on, as one string.
 *
 * Every part is something that changes which names the prelude defines: the plugin version pins the
 * bundled Numbat, the prelude files are what is applied on top of it, and the exchange-rate flag
 * decides whether the currency units are among them.
 */
export function reservedNamesKey(
  version: string,
  preludePaths: readonly string[],
  applyRates: boolean,
): string {
  return `${version}\u0000${digest(preludePaths.join("\u0000"))}\u0000${applyRates ? "1" : "0"}`;
}

/**
 * The names a stored record still stands for, or `null` when it does not.
 *
 * Defensive about the shape rather than trusting it: `data.json` sits in the user's vault, it is
 * hand-edited and synced between devices, and a malformed record here would make ordinary property
 * names read as prelude names — a silently wrong evaluation rather than an error.
 */
export function seededReservedNames(stored: unknown, key: string): readonly string[] | null {
  if (stored === null || typeof stored !== "object") {
    return null;
  }

  const record = stored as Partial<ReservedNamesRecord>;
  if (record.key !== key || !Array.isArray(record.names)) {
    return null;
  }

  return record.names.every((name) => typeof name === "string") ? record.names : null;
}

/** Whether two name sets differ — what decides whether an arriving set has to move `reservedEpoch`,
 *  or whether the seed already said the same thing and every open note can be left alone. */
export function reservedNamesDiffer(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size !== b.size || [...a].some((name) => !b.has(name));
}
