// Where this plugin's property types sit in Obsidian's type menu.
//
// Obsidian builds that menu by iterating `metadataTypeManager.registeredTypeWidgets`, and a
// record's keys iterate in insertion order — so every type registered during `onload` lands in a
// clump after the six built-in ones, in whatever order the plugin happened to register them. The
// fix is to rewrite the record's *key order*, which is the only thing the menu reads: sort every
// entry by the name it shows under, and ours fall into place among Obsidian's. Better Properties
// does the same to the same record, so a vault with both installed sees one alphabetical list
// rather than two plugins disagreeing about it.
//
// Everything with a decision in it lives here, apart from Obsidian: this module imports nothing, so
// the ordering is unit-testable. properties/registry.ts is the half that touches the registry.

/**
 * The registry's keys, sorted by the name each type shows under.
 *
 * `displayName` is passed in rather than read off the widgets, because a widget is an object
 * Obsidian owns and this module is meant to stay free of it. Ties break on the key, so two types
 * that show the same name still order deterministically — without that, `sort` is free to leave
 * them in either order and the "has anything moved?" check in properties/registry.ts could see
 * movement forever.
 *
 * **Idempotent**: sorting an already-sorted list returns it unchanged. That is what makes it safe
 * to re-run this on every `changed` event.
 */
export function plannedOrder(keys: readonly string[], displayName: (key: string) => string): string[] {
  const named = keys.map((key) => ({ key, name: displayName(key) }));
  named.sort((a, b) => (a.name === b.name ? a.key.localeCompare(b.key) : a.name.localeCompare(b.name)));
  return named.map((entry) => entry.key);
}

/**
 * The order to put back on unload: the keys as they were found, in the order they were found in,
 * followed by anything registered since, in its current relative order.
 *
 * Keys that have gone are dropped, which is what makes this correct whichever way round Obsidian
 * runs a plugin's disposers. If the restore runs before this plugin's own types are unregistered,
 * they are absent from `pristine` and so land in the tail — and are deleted a moment later. If it
 * runs after, they are already gone from `current`. Either way the reader is left with the order
 * they had before the plugin was enabled, plus whatever else has arrived since.
 */
export function restoredOrder(current: readonly string[], pristine: readonly string[]): string[] {
  const live = new Set(current);
  const known = new Set(pristine);
  return [...pristine.filter((key) => live.has(key)), ...current.filter((key) => !known.has(key))];
}

/**
 * Rewrite a record's key order in place.
 *
 * **In place, and deliberately so**: Obsidian and every other plugin that has touched the registry
 * hold a reference to this object, so replacing it would leave them all writing into a copy nothing
 * reads. Delete-and-reinsert is the only way to reorder the keys of the object they are all
 * holding.
 *
 * A no-op unless `order` is a permutation of the record's current keys — a caller working from a
 * stale key list would otherwise drop entries — and unless it actually differs from the order the
 * record is already in.
 *
 * (Integer-like keys iterate before string ones whatever order they are inserted in. No property
 * type id is integer-like — they are all `text`, `datetime`, `numbat:expression` and the like — so
 * this is a note rather than a caveat.)
 *
 * @returns whether the record was rewritten.
 */
export function applyKeyOrder(record: Record<string, unknown>, order: readonly string[]): boolean {
  const current = Object.keys(record);
  const unique = new Set(order);
  if (unique.size !== current.length || !current.every((key) => unique.has(key))) {
    return false; // not a permutation: something was registered or removed since `order` was built
  }

  if (current.every((key, index) => key === order[index])) {
    return false;
  }

  const values = new Map(Object.entries(record));
  for (const key of current) {
    delete record[key];
  }

  for (const key of order) {
    record[key] = values.get(key);
  }

  return true;
}
