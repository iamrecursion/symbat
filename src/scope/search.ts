// Pure candidate assembly and ranking for the note scope inspector's search box (views/scope.ts):
// everything the tree shows — user prelude declarations, imported bindings, frontmatter properties
// (including the ones that were skipped, and why), block declarations, inline `let`s — plus the
// bundled Numbat prelude's vocabulary, flattened into one ranked result set.
//
// The bundled prelude is only reachable this way: the wasm exposes a flat list of names with no
// module structure and no per-item origin, so there is nothing to build a browsable per-module tree
// out of. A ranked flat search sidesteps that.
//
// No Obsidian and no wasm imports (like scope/model.ts around it), so all of it is unit-testable:
// the fuzzy scorer is injected — Obsidian's `prepareFuzzySearch` satisfies {@link FuzzyScorer}
// structurally, and a fake one drives the tests.

import { classifyCompletion, type CompletionVocabulary, type ExprCategory } from "../completion/expressions";
import type { DeclKind, ScopeEntry, ScopeNode, ScopeTree, SkipEntry } from "./model";

// THE MODEL
// ================================================================================================

/** Whether a result is one of the note's own bindings or comes from the bundled Numbat prelude.
 *  Only a `scope` result has somewhere to jump to. */
export type SearchOrigin = "scope" | "builtin";

/** What a result points at. A discriminated union rather than parallel nullable fields, so the view
 *  narrows it instead of asserting. */
export type SearchTarget =
  | { kind: "entry"; entry: ScopeEntry; }
  | { kind: "skip"; skip: SkipEntry; }
  | { kind: "builtin"; name: string; };

/** One searchable item. */
export interface SearchCandidate {
  /** The row's stable identity — see {@link searchRowKey}. Empty for a builtin, which has no row in
   *  the tree. Two candidates may share a key (a property searchable by both its key and the name
   *  it binds). */
  key: string;

  /** The ids of the nodes from the root down to the one holding this row, so the view can
   *  force-expand the whole chain (a child node's rows stay hidden unless its *parent* is expanded
   *  too). Empty for a builtin. */
  trail: string[];

  /** The containing node's label, for a muted provenance hint. Empty for a builtin. */
  nodeLabel: string;

  /** The exact string that is both scored and rendered — match offsets index into it, so it must
   *  never be a composite. */
  text: string;

  /** Where the candidate came from — the note's scope or the interpreter's builtins — which decides
   *  its ranking tier. */
  origin: SearchOrigin;

  /** The completion category (unit, function, constant, …), for the row's icon. */
  category: ExprCategory;

  /** What choosing the row does: reveal a tree row, or jump to a definition. */
  target: SearchTarget;

  /** A builtin whose name is also bound by the note (rendered muted). The builtin is deliberately
   *  still listed: the note's binding may shadow it, or — for a prelude alias like `m` or `g` — may
   *  silently never have defined at all, and then the builtin is the only real entity. */
  shadowedByScope: boolean;
}

/**
 * A fuzzy scorer: scores `text` against a query fixed when the scorer was built, returning the
 * score and the matched character ranges, or `null` for no match. A structural supertype of
 * Obsidian's `prepareFuzzySearch` result, so that function passes straight in with no adapter.
 */
export type FuzzyScorer = (text: string) => { score: number; matches: [number, number][]; } | null;

/** A candidate that matched, with everything the view needs to render and rank it. */
export interface SearchHit {
  /** The candidate that matched. */
  candidate: SearchCandidate;

  /** The fuzzy scorer's score; higher is better, and ranks within a tier. */
  score: number;

  /** The matched character ranges in `candidate.text`, for highlighting. */
  matches: [number, number][];

  /** The ranking tier, which outranks {@link score}: note bindings sort above builtins however well
   *  a builtin matches. */
  tier: number;
}

// A separator that cannot occur in a node id or appear in a name. Built rather than written
// literally: a literal NUL in a source file makes grep treat it as binary.
const KEY_SEP = String.fromCharCode(0);

// CANDIDATES
// ================================================================================================

/**
 * A row's identity, stable across refreshes. The view rebuilds the tree — and with it every {@link
 * ScopeEntry} object — on each refresh, and merely clicking into the search box triggers one (it
 * changes the active leaf), so a result may not hold an entry by reference: it addresses the row by
 * node id and position instead.
 *
 * Called by both the candidate walk here and the view's render walk, so the two cannot drift.
 */
export function searchRowKey(nodeId: string, kind: "entry" | "skip", index: number): string {
  return [nodeId, kind, String(index)].join(KEY_SEP);
}

/** A declaration keyword's completion category, so a note's own bindings are tagged without
 *  consulting the wasm vocabulary at all. */
function categoryOf(declKind: DeclKind): ExprCategory {
  switch (declKind) {
    case "unit":
      return "unit";
    case "dimension":
      return "dimension";
    case "fn":
      return "function";
    default:
      return "variable";
  }
}

/**
 * Every candidate the note contributes, walking the render tree so that ids, ordering, and the
 * ancestor trail all come from the same pass the view renders from. `scopeEntries` is deliberately
 * not used: its linearization differs from display order and it drops skips entirely.
 */
function treeCandidates(tree: ScopeTree): SearchCandidate[] {
  const out: SearchCandidate[] = [];

  const walk = (node: ScopeNode, ancestors: string[]): void => {
    const trail = [...ancestors, node.id];
    node.entries.forEach((entry, index) => {
      const key = searchRowKey(node.id, "entry", index);
      const shared = {
        key,
        trail,
        nodeLabel: node.label,
        origin: "scope" as const,
        category: categoryOf(entry.declKind),
        target: { kind: "entry" as const, entry },
        shadowedByScope: false,
      };
      out.push({ ...shared, text: entry.label });

      // A property labeled by its frontmatter key still binds a Numbat name; make it findable under
      // both, as two candidates on the one row rather than one candidate over a composite string
      // (which would break match offsets).
      if (entry.name !== entry.label) {
        out.push({ ...shared, text: entry.name });
      }

      // A nested property reads as `costs.total` in both, which no one searching for `total` would
      // type — so offer the leaf key as well.
      const leaf = entry.path !== undefined && entry.path.length > 1
        ? entry.path[entry.path.length - 1]
        : null;
      if (leaf !== null && leaf !== entry.label && leaf !== entry.name) {
        out.push({ ...shared, text: leaf });
      }
    });

    node.skips.forEach((skip, index) => {
      out.push({
        key: searchRowKey(node.id, "skip", index),
        trail,
        nodeLabel: node.label,
        text: skip.key,
        origin: "scope",
        // A skip bound nothing; tag it as the variable it was meant to be.
        category: "variable",
        target: { kind: "skip", skip },
        shadowedByScope: false,
      });
    });

    for (const child of node.children) {
      walk(child, trail);
    }
  };

  for (const node of tree.nodes) {
    walk(node, []);
  }

  return out;
}

/**
 * Every candidate: the note's own rows (when a note is open) followed by the bundled prelude's
 * vocabulary.
 *
 * The user's own `.nbt` prelude is loaded into the same interpreter context the vocabulary is read
 * from, so its names appear in both. They are one entity, and the tree's copy is the one that can
 * be jumped to — so the vocabulary is filtered by set difference against the names the tree's
 * prelude nodes declare. (A name introduced by an `@aliases(…)` decorator survives the difference
 * and is mislabeled a builtin; the wasm exposes no alias grouping to fix that with.)
 *
 * `tree` may be `null` — with no note open the bundled prelude is still searchable, which makes the
 * panel usable as a Numbat dictionary.
 */
export function scopeSearchCandidates(
  tree: ScopeTree | null,
  vocab: CompletionVocabulary | null,
): SearchCandidate[] {
  const out: SearchCandidate[] = tree === null ? [] : treeCandidates(tree);
  if (vocab === null) {
    return out;
  }

  const preludeNames = new Set(tree?.prelude.flatMap((file) => file.entries.map((entry) => entry.name)) ?? []);
  const boundNames = new Set(
    out.filter((candidate) => candidate.target.kind === "entry").map((candidate) => candidate.text),
  );

  const seen = new Set<string>();
  for (const name of [...vocab.functions, ...vocab.units, ...vocab.variables, ...vocab.dimensions]) {
    if (seen.has(name) || preludeNames.has(name)) {
      continue; // already emitted from another bucket, or it is the user's own
    }
    seen.add(name);

    const category = classifyCompletion(name, vocab);
    if (category === null) {
      continue; // nothing the completer would offer either
    }

    out.push({
      key: "",
      trail: [],
      nodeLabel: "",
      text: name,
      origin: "builtin",
      category,
      target: { kind: "builtin", name },
      shadowedByScope: boundNames.has(name),
    });
  }
  return out;
}

// RANKING
// ================================================================================================

/** How well a candidate matches, before its fuzzy score is consulted. Lower is better; a note's own
 *  binding outranks a builtin at equal quality, because only it is actionable and this is the
 *  *note* scope inspector. */
function tierOf(candidate: SearchCandidate, query: string): number {
  const later = candidate.origin === "scope" ? 0 : 1;
  if (candidate.text === query) {
    return later; // 0 exact in scope, 1 exact builtin
  }

  const text = candidate.text.toLowerCase();
  const needle = query.toLowerCase();
  if (text === needle) {
    return 2;
  }

  return (text.startsWith(needle) ? 3 : 5) + later;
}

/**
 * Rank every candidate matching `query`, best first. Returns them all — the caller caps how many
 * rows it draws and reports the remainder, rather than truncating silently here.
 *
 * Ordering is a lexicographic tuple — tier, then score (higher first), then the shorter name, then
 * alphabetically — rather than additive boosts, so no assumption is made about the scorer's scale
 * or sign. The final alphabetical tiebreak makes the order total and therefore *stable*: an order
 * that reshuffled between keystrokes would make arrow-key navigation jump around as the user types.
 *
 * Where a row is searchable under two names (a property's key and the name it binds), only its
 * best-matching one is kept, so the row appears once.
 */
export function rankSearchCandidates(
  candidates: readonly SearchCandidate[],
  query: string,
  score: FuzzyScorer,
): SearchHit[] {
  const needle = query.trim();
  if (needle === "") {
    return [];
  }

  const hits: SearchHit[] = [];
  for (const candidate of candidates) {
    const result = score(candidate.text);
    if (result !== null) {
      hits.push({ candidate, score: result.score, matches: result.matches, tier: tierOf(candidate, needle) });
    }
  }

  hits.sort((a, b) =>
    a.tier - b.tier
    || b.score - a.score
    || a.candidate.text.length - b.candidate.text.length
    || (a.candidate.text < b.candidate.text ? -1 : a.candidate.text > b.candidate.text ? 1 : 0)
  );

  // Keep each tree row once, at its best-matching name. Builtins carry no key and are each their
  // own row, so they are never collapsed together.
  const kept = new Set<string>();
  return hits.filter((hit) => {
    const { key } = hit.candidate;
    if (key === "") {
      return true;
    }

    if (kept.has(key)) {
      return false;
    }
    kept.add(key);

    return true;
  });
}
