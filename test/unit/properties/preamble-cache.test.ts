// The preamble memos: what counts as a hit, and — the half that can go wrong quietly — what a note
// change drops and what it deliberately leaves alone.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { EMPTY_PREAMBLE, type NotePreamble } from "../../../src/properties/parse.ts";
import {
  bumpReservedEpoch,
  cachedExports,
  cachedForBody,
  cachedForRecord,
  cachedImportWalk,
  invalidateAllPreambles,
  invalidatePreamblesFor,
  type PreambleSettings,
  preambleStamp,
} from "../../../src/properties/preamble-cache.ts";
import { PREAMBLE_BODY_CACHE_ENTRIES, PREAMBLE_FILE_CACHE_ENTRIES } from "../../../src/tuning.ts";

const SETTINGS: PreambleSettings = {
  noteProperties: true,
  notePropertyNumbers: true,
  notePropertyText: false,
  notePropertyDates: true,
  notePropertyBooleans: false,
  noteImports: true,
  notePropertyDefaultZone: "",
};

const STAMP = "stamp";

/** A preamble distinguishable by its `source`, standing in for a real derivation. */
function preamble(source: string): NotePreamble {
  return { ...EMPTY_PREAMBLE, source };
}

/** A `compute` that counts how often it was actually called. */
function counting<T>(value: T): (() => T) & { calls: number; } {
  const fn = (): T => {
    fn.calls += 1;
    return value;
  };
  fn.calls = 0;
  return fn;
}

beforeEach(() => invalidateAllPreambles());

describe("cachedForRecord", () => {
  it("derives once while the same record object comes back", () => {
    const record = { a: 1 };
    const compute = counting(preamble("a"));

    assert.equal(cachedForRecord("n.md", record, STAMP, compute).source, "a");
    assert.equal(cachedForRecord("n.md", record, STAMP, compute).source, "a");
    assert.equal(compute.calls, 1);
  });

  // The load-bearing assumption: Obsidian replaces the parsed frontmatter object on re-parse, so a
  // changed note misses here without needing an event to arrive first.
  it("re-derives for an equal but distinct record", () => {
    const compute = counting(preamble("a"));
    cachedForRecord("n.md", { a: 1 }, STAMP, compute);
    cachedForRecord("n.md", { a: 1 }, STAMP, compute);
    assert.equal(compute.calls, 2);
  });

  it("re-derives when the stamp moves", () => {
    const record = { a: 1 };
    const compute = counting(preamble("a"));
    cachedForRecord("n.md", record, STAMP, compute);
    cachedForRecord("n.md", record, "other", compute);
    assert.equal(compute.calls, 2);
  });

  it("does not serve one note's preamble for another", () => {
    const record = { a: 1 };
    assert.equal(cachedForRecord("a.md", record, STAMP, () => preamble("a")).source, "a");
    assert.equal(cachedForRecord("b.md", record, STAMP, () => preamble("b")).source, "b");
  });

  // This is the cap sized against a Bases table, so it is the one where write-order eviction would
  // drop the rows the reader is scrolling back to.
  it("evicts least recently used, so a note read back outlives one that was not", () => {
    const records = new Map<string, object>();
    const compute = counting(preamble("a"));
    const ask = (path: string): void => {
      const record = records.get(path) ?? { path };
      records.set(path, record);
      cachedForRecord(path, record, STAMP, compute);
    };

    for (let i = 0; i < PREAMBLE_FILE_CACHE_ENTRIES; i += 1) {
      ask(`n${i}.md`);
    }
    assert.equal(compute.calls, PREAMBLE_FILE_CACHE_ENTRIES);

    ask("n0.md");
    assert.equal(compute.calls, PREAMBLE_FILE_CACHE_ENTRIES, "the read was a hit");

    ask("new.md"); // one past the cap
    assert.equal(compute.calls, PREAMBLE_FILE_CACHE_ENTRIES + 1);

    ask("n0.md");
    assert.equal(compute.calls, PREAMBLE_FILE_CACHE_ENTRIES + 1, "the note that was read is still held");

    ask("n1.md");
    assert.equal(compute.calls, PREAMBLE_FILE_CACHE_ENTRIES + 2, "the one behind it went instead");
  });
});

describe("cachedForBody", () => {
  it("derives once for equal text, however it is spelled", () => {
    const compute = counting(preamble("a"));
    cachedForBody("n.md", ["x: 1", "y: 2"], STAMP, compute);
    cachedForBody("n.md", ["x: 1", "y: 2"], STAMP, compute); // a different array, same content
    assert.equal(compute.calls, 1);
  });

  it("re-derives when the text, the path or the stamp moves", () => {
    const compute = counting(preamble("a"));
    cachedForBody("n.md", ["x: 1"], STAMP, compute);
    cachedForBody("n.md", ["x: 2"], STAMP, compute);
    cachedForBody("m.md", ["x: 1"], STAMP, compute);
    cachedForBody("n.md", ["x: 1"], "other", compute);
    assert.equal(compute.calls, 4);
  });

  // The stamp carries its own separators, so the key is only unambiguous because the body comes
  // last and note text holds no NUL.
  it("does not let a stamp bleed into the body", () => {
    const compute = counting(preamble("a"));
    cachedForBody("n.md", ["x"], "one", compute);
    cachedForBody("n.md", ["x"], "one", compute);
    assert.equal(compute.calls, 1);
  });

  it("evicts past the cap, least recently used first", () => {
    const compute = counting(preamble("a"));
    for (let i = 0; i <= PREAMBLE_BODY_CACHE_ENTRIES; i += 1) {
      cachedForBody("n.md", [`x: ${i}`], STAMP, compute);
    }
    assert.equal(compute.calls, PREAMBLE_BODY_CACHE_ENTRIES + 1);

    cachedForBody("n.md", ["x: 0"], STAMP, compute);
    assert.equal(compute.calls, PREAMBLE_BODY_CACHE_ENTRIES + 2, "with nothing read back, that is the first entry");

    cachedForBody("n.md", [`x: ${PREAMBLE_BODY_CACHE_ENTRIES}`], STAMP, compute);
    assert.equal(compute.calls, PREAMBLE_BODY_CACHE_ENTRIES + 2, "the newest entry survived");
  });

  // Reading is the signal, not writing: a Bases table longer than the cap would otherwise evict
  // precisely the rows being scrolled back to, whatever the cap.
  it("a hit spares an entry the eviction it was next in line for", () => {
    const compute = counting(preamble("a"));
    for (let i = 0; i < PREAMBLE_BODY_CACHE_ENTRIES; i += 1) {
      cachedForBody("n.md", [`x: ${i}`], STAMP, compute);
    }
    assert.equal(compute.calls, PREAMBLE_BODY_CACHE_ENTRIES);

    // The oldest entry, read back and so no longer the oldest.
    cachedForBody("n.md", ["x: 0"], STAMP, compute);
    assert.equal(compute.calls, PREAMBLE_BODY_CACHE_ENTRIES, "the read was a hit");

    // One past the cap: something has to go, and it is the entry the read displaced.
    cachedForBody("n.md", ["x: new"], STAMP, compute);
    assert.equal(compute.calls, PREAMBLE_BODY_CACHE_ENTRIES + 1);

    cachedForBody("n.md", ["x: 0"], STAMP, compute);
    assert.equal(compute.calls, PREAMBLE_BODY_CACHE_ENTRIES + 1, "the entry that was read is still held");

    cachedForBody("n.md", ["x: 1"], STAMP, compute);
    assert.equal(compute.calls, PREAMBLE_BODY_CACHE_ENTRIES + 2, "the one behind it went instead");
  });
});

describe("cachedImportWalk", () => {
  // Why the walk is memoized apart from the preambles that embed it: typing changes the note's
  // text, not what it imports.
  it("holds across a change to everything except the targets", () => {
    const compute = counting({ chunks: ["let a = 1"], order: ["dep.md"] });
    cachedImportWalk("n.md", ["[[Dep]]"], STAMP, compute);
    cachedImportWalk("n.md", ["[[Dep]]"], STAMP, compute);
    assert.equal(compute.calls, 1);

    cachedImportWalk("n.md", ["[[Dep]]", "[[Other]]"], STAMP, compute);
    assert.equal(compute.calls, 2);
  });
});

describe("cachedExports", () => {
  it("derives once per imported note while its record stands", () => {
    const record = { a: 1 };
    const compute = counting({ chunks: ["let a = 1"], bindings: [] });
    cachedExports("dep.md", record, STAMP, compute);
    cachedExports("dep.md", record, STAMP, compute);
    assert.equal(compute.calls, 1);
  });
});

describe("invalidatePreamblesFor", () => {
  const counts = { walks: 0, body: 0 };
  beforeEach(() => {
    counts.walks = 0;
    counts.body = 0;
  });

  /** Ask for `importer`'s walk (which transitively visited `order`) and for the preamble built on
   *  it, counting whichever of the two actually had to be derived. */
  function populate(importer: string, order: string[]): void {
    cachedImportWalk(importer, ["[[Dep]]"], STAMP, () => {
      counts.walks += 1;
      return { chunks: [], order };
    });
    cachedForBody(importer, ["x: 1"], STAMP, () => {
      counts.body += 1;
      return preamble(importer);
    });
  }

  it("drops the note's own entries", () => {
    const record = { a: 1 };
    const compute = counting(preamble("a"));
    cachedForRecord("n.md", record, STAMP, compute);

    invalidatePreamblesFor("n.md");
    cachedForRecord("n.md", record, STAMP, compute);
    assert.equal(compute.calls, 2);
  });

  it("drops the notes that imported it", () => {
    populate("importer.md", ["dep.md"]);
    populate("importer.md", ["dep.md"]);
    assert.deepEqual(counts, { walks: 1, body: 1 });

    invalidatePreamblesFor("dep.md");
    populate("importer.md", ["dep.md"]);
    assert.deepEqual(counts, { walks: 2, body: 2 }, "both the walk and the preamble built on it went");
  });

  // `order` is the transitive visit list, so a change at the bottom of a chain reaches the top.
  it("reaches an importer two notes away", () => {
    populate("top.md", ["bottom.md", "middle.md"]);
    populate("top.md", ["bottom.md", "middle.md"]);
    assert.equal(counts.walks, 1);

    invalidatePreamblesFor("bottom.md");
    populate("top.md", ["bottom.md", "middle.md"]);
    assert.equal(counts.walks, 2);
  });

  // The walk memo is the reverse index this scans, which is the second job it does and the one that
  // sizes it. At 32 entries against a 128-entry file memo, a Bases table over forty importing notes
  // evicted the walks of rows it had already shown — and an importer whose walk has gone is an
  // importer this cannot find, left holding a preamble built from the imports as they were. Nothing
  // else catches that: `cachedForRecord` hits on the *importer's own* record, which an edit to the
  // note it imports does not touch.
  it("reaches an importer whose preamble is memoized at the file cache's capacity", () => {
    const records = new Map<string, object>();
    let derived = 0;

    // One importing note, asked for exactly as `preambleForFile` asks: the walk first, then the
    // preamble built on it, both against a record object Obsidian keeps handing back.
    const fill = (importer: string): void => {
      const record = records.get(importer) ?? {};
      records.set(importer, record);
      cachedImportWalk(importer, ["[[Dep]]"], STAMP, () => ({ chunks: [], order: ["dep.md"] }));
      cachedForRecord(importer, record, STAMP, () => {
        derived += 1;
        return preamble(importer);
      });
    };

    for (let i = 0; i < PREAMBLE_FILE_CACHE_ENTRIES; i += 1) {
      fill(`importer-${i}.md`);
    }
    assert.equal(derived, PREAMBLE_FILE_CACHE_ENTRIES, "every importer memoized, none evicted");

    invalidatePreamblesFor("dep.md");

    fill("importer-0.md");
    assert.equal(derived, PREAMBLE_FILE_CACHE_ENTRIES + 1, "the first importer of all re-derived");
  });

  // The reason the invalidation is path-scoped at all: one note being edited must not make every
  // row of an open Bases table re-derive.
  it("leaves an unrelated note alone", () => {
    const record = { a: 1 };
    const compute = counting(preamble("a"));
    cachedForRecord("other.md", record, STAMP, compute);

    invalidatePreamblesFor("n.md");
    cachedForRecord("other.md", record, STAMP, compute);
    assert.equal(compute.calls, 1);
  });
});

describe("preambleStamp", () => {
  it("moves with each setting the derivation reads", () => {
    const base = preambleStamp(SETTINGS);
    for (const key of Object.keys(SETTINGS) as (keyof PreambleSettings)[]) {
      const changed = key === "notePropertyDefaultZone"
        ? { ...SETTINGS, notePropertyDefaultZone: "Europe/Berlin" }
        : { ...SETTINGS, [key]: !SETTINGS[key] };
      assert.notEqual(preambleStamp(changed), base, `${key} is not folded into the stamp`);
    }
  });

  it("moves when the reserved names arrive", () => {
    const before = preambleStamp(SETTINGS);
    bumpReservedEpoch();
    assert.notEqual(preambleStamp(SETTINGS), before);
  });
});
