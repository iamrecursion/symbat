// A reload guard for state that is read asynchronously, invalidated from elsewhere, and depended on
// by several callers at once — the user prelude being the case it was written for.
//
// A plain dirty flag cannot express this. Clearing it before the read lets a second caller see
// "clean" and proceed against state that has not been applied yet; clearing it after the read
// swallows any invalidation that arrived while the read was in flight. Versioning fixes both:
// `loaded` catches up to `version` only once the sources *that version names* have been applied,
// and an invalidation mid-read pushes `version` beyond what the running load can stamp.
//
// No imports, so it is unit-testable without Obsidian or the wasm bindings.

/**
 * Serializes reloads of one piece of derived state.
 *
 * `load` is never run concurrently with itself: overlapping {@link ensure} calls share the
 * in-flight pass. A caller that arrives after an invalidation but while an older load is still
 * running waits for that one *and then* for a fresh one, so `ensure()` resolving always means the
 * latest known sources are applied.
 *
 * If `load` rejects, the version is not stamped (so the next `ensure` retries) and the rejection
 * reaches every caller awaiting that pass.
 */
export class VersionedLoad {
  /** Bumped by {@link invalidate}; names the newest generation of the sources. */
  private version = 1;

  /** The newest version {@link load} has finished applying. Starts behind {@link version}, so the
   *  first {@link ensure} always loads. */
  private loaded = 0;

  /** The running load, shared by every concurrent {@link ensure}, or `null` when none is
   *  running. */
  private inFlight: Promise<void> | null = null;

  /** @param load applies the current sources; called with no overlap of itself. */
  constructor(private readonly load: () => Promise<void>) {}

  /** Note that the underlying sources changed; the next {@link ensure} reloads. */
  invalidate(): void {
    this.version += 1;
  }

  /** Whether a reload is outstanding. */
  get stale(): boolean {
    return this.loaded !== this.version;
  }

  /** Resolve once the latest sources have been applied, loading if needed. */
  async ensure(): Promise<void> {
    while (this.loaded !== this.version) {
      if (this.inFlight === null) {
        // Captured before `load` starts: an `invalidate()` during the read moves `version` past
        // this, so the stamp cannot mark the stale read current and the loop runs again.
        const version = this.version;
        this.inFlight = this.load()
          .then(() => {
            this.loaded = version;
          })
          .finally(() => {
            this.inFlight = null;
          });
      }
      await this.inFlight;
    }
  }
}
