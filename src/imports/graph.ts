// The stateful side of cross-note imports: a cache of each note's `numbat-shared` block code, keyed
// by path. The import graph walk (imports/parse.ts) and the scope attachment (properties/note.ts)
// need a note's shared code *synchronously* (an editor's `build()` runs on the update path), but
// reading a note's content is async — so this reads on demand into a sync cache and, when a read
// lands or a cached note changes, fires `onUpdate` (→ refreshNoteScope) to re-evaluate the notes
// that import it. Eventually consistent, exactly like the inlay block cache.
//
// A note's *frontmatter* (its own `numbat-use` and typed properties) is read live from the metadata
// cache by properties/note.ts, so only the block code — which the metadata cache does not hold — is
// cached here.

import { numbatBlockRanges } from "../document/fences";
import type SymbatPlugin from "../main";

/** How long after a read (or a change) to coalesce refreshes, so a burst of note changes
 *  re-evaluates importers once. */
const REFRESH_DEBOUNCE_MS = 50;

/**
 * The vault-wide cache of `numbat-shared` block code, keyed by note path.
 *
 * Reads are lazy and asynchronous — {@link sharedBlocks} answers `[]` for a note it has not read
 * yet and schedules the read, notifying `onUpdate` when it lands — so the evaluating surfaces stay
 * synchronous and simply re-render once the code arrives. One instance per plugin, disposed on
 * unload.
 */
export class ModuleGraph {
  /** Note path → its `numbat-shared` blocks (each block's body, kept separate so a broken block
   *  does not sink the others on replay). An empty array records a note with no shared blocks, so
   *  it is not re-read every build. */
  private readonly shared = new Map<string, string[]>();

  /** Reads currently in flight, so a note is not read twice concurrently. */
  private readonly reading = new Set<string>();

  /** The pending coalesced refresh, or `null` when none is scheduled. */
  private refreshTimer: number | null = null;

  /** Set by {@link dispose}, so a read still in flight discards its result rather than repopulating
   *  the cache of an unloaded plugin. */
  private disposed = false;

  /**
   * @param plugin supplies the vault to read notes from and the import setting.
   * @param onUpdate called after the cache changes, so importers re-evaluate.
   */
  constructor(private readonly plugin: SymbatPlugin, private readonly onUpdate: () => void) {}

  /**
   * A note's `numbat-shared` blocks (each block's body, separate), or `[]` when it is not yet read
   * (a read is scheduled, and `onUpdate` fires once the blocks are in hand so importers pick them
   * up). Also `[]` for a note with no shared blocks.
   */
  sharedBlocks(path: string): string[] {
    const cached = this.shared.get(path);
    if (cached !== undefined) {
      return cached;
    }
    void this.read(path);
    return [];
  }

  /** A note changed: if it is one whose shared blocks we hold (i.e. some open note imports it),
   *  re-read those blocks *and* refresh its importers. The refresh is unconditional because a
   *  note's exported typed properties are read live from the metadata cache, not cached here — so a
   *  frontmatter-only edit (which leaves the shared blocks unchanged) must still re-evaluate
   *  importers. The refresh is a cheap effect dispatch, coalesced, and a note nothing imports is
   *  ignored. */
  noteChanged(path: string): void {
    if (this.shared.has(path) || this.reading.has(path)) {
      void this.read(path);
      this.scheduleRefresh();
    }
  }

  /** Bumped by {@link reset}; a read stamps itself with the value it started at and discards its
   *  result if this has moved, so a read begun before a rename cannot write pre-rename content over
   *  the cache the rename cleared. */
  private epoch = 0;

  /** Paths whose content changed while a read of them was in flight, so that read captured a stale
   *  snapshot and another is owed. */
  private readonly restale = new Set<string>();

  /** A rename or delete can change which note any link resolves to — clear the whole cache and
   *  refresh (both events are rare). */
  reset(): void {
    if (this.shared.size === 0 && this.reading.size === 0) {
      return;
    }

    this.shared.clear();
    this.reading.clear();
    this.restale.clear();

    // Reads already in flight resolve against the cleared cache; the epoch is what stops them
    // writing what they captured before the rename.
    this.epoch += 1;
    this.scheduleRefresh();
  }

  /** Release the graph on plugin unload: cancel the pending refresh and stop any in-flight read
   *  from writing back. */
  dispose(): void {
    this.disposed = true;

    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Read (or re-read) a note's shared-block code into the cache, refreshing importers if it
   * changed.
   *
   * A read already in flight for this path is not duplicated; instead the path is marked owed a
   * re-read, because the in-flight one may have captured the note as it was before the change that
   * prompted this call. The result is discarded entirely if {@link reset} ran while it was
   * outstanding — otherwise a read begun before a rename would write pre-rename content over the
   * cleared cache, and re-populate an entry for a path that may no longer exist.
   */
  private async read(path: string): Promise<void> {
    if (this.reading.has(path)) {
      this.restale.add(path);
      return;
    }

    this.reading.add(path);
    const epoch = this.epoch;

    let blocks: string[] = [];
    try {
      const file = this.plugin.app.vault.getFileByPath(path);
      if (file !== null) {
        const text = await this.plugin.app.vault.cachedRead(file);
        blocks = numbatBlockRanges(text.split("\n"))
          .filter((block) => block.shared)
          .map((block) => block.body.join("\n"));
      }
    } catch (error) {
      console.error("Symbat: failed to read imported note", path, error);
      this.reading.delete(path);
      this.restale.delete(path);
      return;
    }

    this.reading.delete(path);
    if (epoch !== this.epoch || this.disposed) {
      this.restale.delete(path);
      return; // superseded by a reset (or the graph is gone)
    }

    const owed = this.restale.delete(path);
    const previous = this.shared.get(path);
    this.shared.set(path, blocks);

    // Refresh when the blocks changed — treating "not yet known" as "none" so learning a note has
    // no shared blocks triggers no spurious re-evaluation.
    if ((previous ?? []).join("\n") !== blocks.join("\n")) {
      this.scheduleRefresh();
    }

    if (owed) {
      void this.read(path); // the content moved under the read that just finished
    }
  }

  /** Coalesce an `onUpdate` notification. Unlike the usual debounce this does *not* restart the
   *  wait — a burst of note changes should still notify promptly, just once. */
  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer !== null) {
      return;
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.onUpdate();
    }, REFRESH_DEBOUNCE_MS);
  }
}
