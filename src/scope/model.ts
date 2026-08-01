// Pure aggregator for the note scope inspector (views/scope.ts): merge every source a note's Numbat
// scope draws from — cross-note imports, frontmatter properties, `numbat` / `numbat-shared` blocks,
// and inline `let` spans — into one hierarchical tree of collapsible nodes, each binding tagged
// with where it came from and where it is defined. No Obsidian, CodeMirror, or wasm imports (like
// properties/parse.ts / evaluation/inline-parse.ts), so it is unit-testable in isolation; the value
// probing (scope/eval.ts) and the vault bridge (scope/source.ts) sit around it.
//
// There is no single "note unit" model spanning all four sources, so this file runs each source's
// own pure scanner (numbatBlockRanges, scanNote, groupStatements, declarationSite) and stitches
// provenance itself. Values are filled in later, by scope/eval.ts, onto the same ScopeEntry objects
// the nodes hold by reference.

import { numbatBlockRanges } from "../document/fences";
import { FRONTMATTER_CLOSE, FRONTMATTER_OPEN } from "../document/frontmatter";
import { groupStatements, stripLineComment } from "../evaluation/inlay-parse";
import { type InlineEvalConfig, noteSignature, scanNote } from "../evaluation/inline-parse";
import { escapeHtml } from "../interpreter/markup";
import { EMPTY_PREAMBLE, frontmatterKeySites, type NotePreamble, type PropertySkip } from "../properties/parse";

// DECLARATIONS
// ================================================================================================

/** The Numbat declaration keywords the inspector lists. `let` and `unit` bindings evaluate to a
 *  value; `fn` and `dimension` are shown by name + kind only. */
export type DeclKind = "let" | "unit" | "fn" | "dimension";

// A `let`/`unit`/`fn`/`dimension` declaration and its declared name. Broader than
// evaluation/inlay-parse.ts's `declarationSite` (which the type-hint placement restricts to
// `let`/`unit`) so the inspector can list functions, units, and dimensions too.
const DECLARATION = /^\s*(let|unit|fn|dimension)\s+([\p{L}_][\p{L}\p{N}_]*)/u;

/** The declaration a source line introduces, or `null` when it is not one. */
export function scopeDeclaration(line: string): { keyword: DeclKind; name: string; } | null {
  const match = DECLARATION.exec(stripLineComment(line));
  return match === null ? null : { keyword: match[1] as DeclKind, name: match[2] };
}

// THE MODEL
// ================================================================================================

/** Where a binding is defined, for click-to-jump. `notePath` is `null` for a binding in the active
 *  note (jump within it); an imported binding names its source note (round 1 opens that note; the
 *  exact line is round 2, hence `line: null`). Lines are 0-indexed. */
export interface DefSite {
  /** The defining note's vault path, or `null` when it is the active note. */
  notePath: string | null;

  /** The defining line, or `null` when only the note is known. */
  line: number | null;

  /** Column on that line to place the caret at. */
  ch: number;
}

/** The kind of value a binding evaluated to (filled by scope/eval.ts). */
export type ScopeValueKind = "value" | "hole" | "error" | "none";

/** A binding's evaluated display, mirroring the inlay surfaces. `type` is the formatter's inferred
 *  `: Type` fragment (HTML) when the binding is a `let` whose echo carries one — the same fragment
 *  the block type-hints render. */
export interface ScopeValue {
  /** Which outcome this is, and so which of the fields below are populated. */
  kind: ScopeValueKind;

  /** The `= value` fragment (HTML), trailing `[Dim]` dropped. */
  resultHtml: string | null;

  /** The bare value (HTML), no leading `=`. */
  valueHtml: string | null;

  /** The bare value as plain text. */
  plain: string | null;

  /** The missing-operand type for an incomplete expression (`kind === "hole"`). */
  holeType: string | null;

  /** The diagnostic summary line for a failed binding (`kind === "error"`). */
  errorText: string | null;

  /** The inferred `: Type` fragment (HTML), or `null` when none is available. */
  type: string | null;
}

/** Which of a note's scope sources a binding came from. `local` is a plain `numbat` block —
 *  evaluated for the inspector but *not* exported into scope; `prelude` is the user's own `.nbt`
 *  prelude. */
export type ScopeSourceKind =
  | "import"
  | "property"
  | "number"
  | "shared"
  | "local"
  | "inline"
  | "prelude"
  /** A declaration in a standalone `.nbt` file being edited (see {@link buildDocumentScopeTree}) —
   *  the whole file is the scope. */
  | "file";

/** One binding in the note's scope. Built pure (no value); scope/eval.ts fills {@link value} by
 *  reference. */
export interface ScopeEntry {
  /** Which of the note's scope sources contributed this binding. */
  sourceKind: ScopeSourceKind;

  /** The declaration keyword — `let`/`unit` carry a value, `fn`/`dimension` a kind label only. A
   *  property binds a `let`. */
  declKind: DeclKind;

  /** The Numbat identifier the binding introduces. */
  name: string;

  /** What to label the row — the property key when it differs from `name`, else `name`. */
  label: string;

  /** For a frontmatter property, the keys leading to it (`["costs", "total"]`); absent for every
   *  other kind of binding. Drives the nested grouping under the Frontmatter node, and the leaf-key
   *  search candidate. */
  path?: string[];

  /** The definition expression to show (a property's value, or a `let`'s RHS). */
  expr: string;

  /** The full statement to run when evaluating (`let name = (expr)` for a property; the verbatim
   *  `let` statement for a block / inline / import binding). */
  code: string;

  /** How scope/eval.ts probes this binding: `expr` evaluates the RHS then defines the statement
   *  (properties, matching the frontmatter inlays); `definition` runs the statement then reads the
   *  bound name (blocks, inline, imports). */
  probe: "expr" | "definition";

  /** Where the binding is defined, for click-to-jump. */
  defsite: DefSite;

  /** Whether a later binding of the same name supersedes this one in scope. */
  shadowed: boolean;

  /** The evaluated display, filled in by scope/eval.ts — absent until the tree has been evaluated,
   *  and on a tree built purely for structure. */
  value?: ScopeValue;
}

/** A frontmatter property that contributed no binding, and why. */
export type SkipEntry = PropertySkip;

/** The kinds of collapsible tree node. */
export type ScopeNodeKind =
  | "imports"
  | "import-note"
  | "frontmatter"
  | "frontmatter-object"
  | "skipped"
  | "block"
  | "inline"
  | "prelude"
  | "prelude-file"
  | "file";

/** One node of the scope tree — a collapsible group with either leaf `entries`, `skips`, or child
 *  nodes. */
export interface ScopeNode {
  /** Stable across refreshes (never line-based), so expansion state survives an edit: `imports`,
   *  `import:<notePath>`, `frontmatter`, `property:<dotted key>`, `skipped`, `block:<n>`,
   *  `inline`. */
  id: string;

  /** Which kind of group this is, selecting the row's icon and styling. */
  kind: ScopeNodeKind;

  /** The heading text for the row. */
  label: string;

  /** A short qualifier shown by the label (`local`, `exports`, a count), or null. */
  badge: string | null;

  /** The node's contiguous span in the active note (0-indexed, inclusive), for caret→current-node
   *  mapping; `null` for external / scattered nodes. */
  range: { fromLine: number; toLine: number; } | null;

  /** The bindings shown directly under this node. */
  entries: ScopeEntry[];

  /** Frontmatter properties that bound nothing, with the reason (`skipped` nodes). */
  skips: SkipEntry[];

  /** Nested groups — import notes, frontmatter objects, prelude files. */
  children: ScopeNode[];
}

/** A `numbat` / `numbat-shared` block's scope, for evaluation: its statements (each a run-step,
 *  with a `let`'s display entry attached) and the whole body used to seed later blocks. */
export interface BlockScope {
  /** Whether this is a `numbat-shared` block, whose bindings enter the note's scope and are visible
   *  to importers; a plain `numbat` block is evaluated for display only. */
  exported: boolean;

  /** 0-indexed line of the opening fence. */
  openLine: number;

  /** 0-indexed line of the closing fence. */
  closeLine: number;

  /** The body verbatim, replayed as a unit to seed the blocks below it. */
  wholeBody: string;

  /** The body split into run-steps, each with the display entry it declares (or `null` for a
   *  statement that binds nothing). */
  statements: { code: string; entry: ScopeEntry | null; }[];
}

/** The imports of a note grouped by source note, for evaluation: each note's raw chunks (replayed
 *  whole) and the display entries parsed out of them. */
export interface ImportScope {
  /** Vault path of the note the bindings were imported from. */
  notePath: string;

  /** That note's `numbat-shared` bodies, replayed verbatim to define the bindings. */
  chunks: string[];

  /** The display entries parsed out of those chunks. */
  entries: ScopeEntry[];
}

/** One user-prelude `.nbt` file's declarations. The prelude is loaded into every context, so its
 *  bindings' values are probed directly (no chunk replay). */
export interface PreludeScope {
  /** A display label — the file's configured name, else its basename. */
  label: string;

  /** The vault path, for click-to-jump. */
  path: string;

  /** The declarations the file introduces. */
  entries: ScopeEntry[];
}

/**
 * A user-prelude file's raw content, the input to {@link buildScopeTree}.
 *
 * Distinct from `settings/util.ts`'s `PreludeFile`, which is the *setting* — a label and a vault
 * path the user configured. This is what one of those looks like once read off disk.
 */
export interface PreludeFileLines {
  /** The file's configured display name, else its basename. */
  label: string;

  /** The vault path it was read from. */
  path: string;

  /** Its content, split into lines. */
  lines: string[];
}

/** The whole note-scope model: the render tree, the evaluation-oriented views onto the same entry
 *  objects, and the cache signature. */
export interface ScopeTree {
  /** The active note's vault path — what the tree describes. */
  file: string;

  /** The render tree: the collapsible groups, in display order. */
  nodes: ScopeNode[];

  /** Imported bindings grouped by source note, in replay order. */
  imports: ImportScope[];

  /** Bindings contributed by frontmatter properties. */
  properties: ScopeEntry[];

  /** The note's `numbat` and `numbat-shared` blocks, in document order. */
  blocks: BlockScope[];

  /** Bindings contributed by inline `let` spans. */
  inline: ScopeEntry[];

  /** The user prelude's declarations, one group per configured file. */
  prelude: PreludeScope[];

  /** The scanNote units, in document order — the interleave of shared blocks and inline spans
   *  scope/eval.ts replays for the in-scope inline values. */
  units: ReturnType<typeof scanNote>;

  /** The note's property bindings and skips, as properties/parse.ts produced them — the source
   *  `properties` above is derived from. */
  preamble: NotePreamble;

  /** Doc lines carrying an inline `let` span, for caret→current mapping. */
  inlineLines: number[];

  /** Everything this tree was built from, folded into one string. The inspector caches evaluated
   *  values against it, so a tree that would evaluate identically is not re-run — and one that
   *  would not, is. */
  signature: string;

  /** Whether the note contributed no bindings at all, so the view can show its empty state rather
   *  than a tree of empty groups. */
  empty: boolean;
}

// BUILDING THE PIECES
// ================================================================================================

/** The right-hand side of a `let` statement, for display — the text past the first `=`, trimmed.
 *  Falls back to the whole statement when there is no `=`. */
function letRhs(statement: string): string {
  const eq = statement.indexOf("=");
  return eq === -1 ? statement.trim() : statement.slice(eq + 1).trim();
}

/** A binding entry from a verbatim declaration statement (block / inline / import / prelude). */
function declEntry(
  sourceKind: ScopeSourceKind,
  statement: string,
  decl: { keyword: DeclKind; name: string; },
  defsite: DefSite,
): ScopeEntry {
  return {
    sourceKind,
    declKind: decl.keyword,
    name: decl.name,
    label: decl.name,
    expr: letRhs(statement),
    code: statement,
    probe: "definition",
    defsite,
    shadowed: false,
  };
}

// YAML frontmatter delimiters, matching properties/parse.ts / NoteWalk.

/** The `[fromLine, toLine]` span of the note's frontmatter (the `---` fences included), or `null`
 *  when it has none. */
function frontmatterRange(lines: string[]): { fromLine: number; toLine: number; } | null {
  if (lines.length === 0 || !FRONTMATTER_OPEN.test(lines[0])) {
    return null;
  }

  for (let i = 1; i < lines.length; i += 1) {
    if (FRONTMATTER_CLOSE.test(lines[i])) {
      return { fromLine: 0, toLine: i };
    }
  }

  return null; // an opener that never closed
}

/** The imported bindings, grouped by source note, from the per-note chunks the bridge gathered
 *  (importGroups). Each chunk (a typed-property `let` or a shared block body) is split into
 *  statements; every declaration becomes a display entry. */
function buildImports(groups: { notePath: string; chunks: string[]; }[]): ImportScope[] {
  return groups.map((group) => {
    const entries: ScopeEntry[] = [];
    for (const chunk of group.chunks) {
      for (const statement of groupStatements(chunk.split("\n"))) {
        const decl = scopeDeclaration(statement.text);

        if (decl !== null) {
          entries.push(declEntry("import", statement.text, decl, { notePath: group.notePath, line: null, ch: 0 }));
        }
      }
    }

    return { notePath: group.notePath, chunks: group.chunks, entries };
  });
}

/**
 * The property bindings as scope entries (typed expressions and untyped numbers), in frontmatter
 * order, with each key's site located for click-to-jump — one scan of the frontmatter for the whole
 * set, nested keys included.
 *
 * `entries` is the flat, document-ordered list the evaluator replays and the value cache is
 * positional in; `rootEntries` and `objectNodes` are the same entry objects *by reference*, split
 * into what the Frontmatter node shows directly and the sub-tree mirroring the note's YAML objects.
 * The structure comes from the bindings' paths, so an object holding nothing bindable never becomes
 * a node.
 */
function buildProperties(preamble: NotePreamble, lines: string[]): {
  entries: ScopeEntry[];
  rootEntries: ScopeEntry[];
  objectNodes: ScopeNode[];
} {
  const sites = frontmatterKeySites(lines);
  const entries = preamble.bindings.map((binding) => {
    const site = sites.get(binding.key);
    return {
      sourceKind: binding.kind === "number" ? "number" : "property",
      declKind: "let",
      name: binding.name,
      label: binding.key === binding.name ? binding.name : binding.key,
      path: binding.path,
      expr: binding.expr,
      code: binding.code,
      probe: "expr",
      defsite: { notePath: null, line: site?.line ?? null, ch: site?.ch ?? 0 },
      shadowed: false,
    } satisfies ScopeEntry;
  });

  const objectNodes: ScopeNode[] = [];
  const rootEntries: ScopeEntry[] = [];
  const byPath = new Map<string, ScopeNode>();
  const nodeFor = (path: string[]): ScopeNode => {
    const key = path.join(".");
    const known = byPath.get(key);
    if (known !== undefined) {
      return known;
    }

    const site = sites.get(key);
    const node: ScopeNode = {
      id: `property:${key}`,
      kind: "frontmatter-object",
      label: path[path.length - 1],
      badge: null,
      // The whole block the key opens, so the caret anywhere inside it makes this the current node;
      // `null` when the key has no locatable line (flow style).
      range: site === undefined ? null : { fromLine: site.line, toLine: site.endLine },
      entries: [],
      skips: [],
      children: [],
    };

    byPath.set(key, node);

    if (path.length === 1) {
      objectNodes.push(node);
    } else {
      nodeFor(path.slice(0, -1)).children.push(node);
    }

    return node;
  };

  for (const entry of entries) {
    const path = entry.path ?? [];
    if (path.length <= 1) {
      rootEntries.push(entry);
      continue;
    }

    nodeFor(path.slice(0, -1)).entries.push(entry);
  }

  return { entries, rootEntries, objectNodes };
}

/** Every `numbat` / `numbat-shared` block as a {@link BlockScope}: its declarations become display
 *  entries; non-declaration statements are run-only steps that still accumulate state. */
function buildBlocks(lines: string[]): BlockScope[] {
  return numbatBlockRanges(lines).map((block) => ({
    exported: block.shared,
    openLine: block.openLine,
    closeLine: block.closeLine,
    wholeBody: block.body.join("\n"),
    statements: blockStatements(block.body, block.bodyStartLine, block.shared ? "shared" : "local"),
  }));
}

/**
 * A body's statements as run-steps, each with the display entry its declaration introduces (or
 * `null` when it declares nothing). `bodyStartLine` is where the body begins in the document, so
 * every defsite is a real line the caret can be sent to.
 *
 * Shared by a fenced block and by a whole `.nbt` file, which is the same thing without the fence.
 */
function blockStatements(
  body: string[],
  bodyStartLine: number,
  sourceKind: ScopeSourceKind,
): { code: string; entry: ScopeEntry | null; }[] {
  return groupStatements(body).map((statement) => {
    const decl = scopeDeclaration(body[statement.startLine]);
    const entry = decl !== null
      ? declEntry(sourceKind, statement.text, decl, {
        notePath: null,
        line: bodyStartLine + statement.startLine,
        ch: 0,
      })
      : null;
    return { code: statement.text, entry };
  });
}

/** The inline declaration spans as scope entries, in document order, paired with the scanNote units
 *  (needed for the in-scope replay order). */
function buildInline(units: ReturnType<typeof scanNote>): { entries: ScopeEntry[]; lines: number[]; } {
  const entries: ScopeEntry[] = [];
  const lines: number[] = [];
  for (const unit of units) {
    if (unit.kind !== "inline") {
      continue;
    }

    const decl = scopeDeclaration(unit.span.expr);
    if (decl !== null) {
      entries.push(
        declEntry("inline", unit.span.expr, decl, { notePath: null, line: unit.line, ch: unit.span.prefixStart }),
      );
      lines.push(unit.line);
    }
  }

  return { entries, lines };
}

/** The user prelude's declarations, one {@link PreludeScope} per `.nbt` file. Each file is grouped
 *  into statements; every declaration becomes an entry defined in that file. */
function buildPrelude(files: PreludeFileLines[]): PreludeScope[] {
  return files.map((file) => {
    const entries: ScopeEntry[] = [];
    for (const statement of groupStatements(file.lines)) {
      const decl = scopeDeclaration(file.lines[statement.startLine]);
      if (decl !== null) {
        entries.push(declEntry("prelude", statement.text, decl, {
          notePath: file.path,
          line: statement.startLine,
          ch: 0,
        }));
      }
    }

    return { label: file.label, path: file.path, entries };
  });
}

/** Mark every binding a later same-name binding supersedes. In-scope order is imports → properties
 *  → the document-order interleave of shared-block and inline `let`s; the last binding of a name
 *  wins (matching replayPreamble's last-wins), earlier ones are flagged. Local (plain-block)
 *  bindings are not in scope, so they do not participate. */
function markShadows(
  imports: ImportScope[],
  properties: ScopeEntry[],
  blocks: BlockScope[],
  inline: ScopeEntry[],
): void {
  const sharedLets = blocks
    .filter((block) => block.exported)
    .flatMap((block) =>
      block.statements.map((statement) => statement.entry).filter((entry): entry is ScopeEntry => entry !== null)
    );

  // Imports and properties precede the body; shared-block and inline lets follow in document order
  // (they were both built in document order, so concatenating keeps it close enough for last-wins —
  // an exact interleave is not needed for "which is authoritative", only the final occurrence of
  // each name is).
  const inScope = [...imports.flatMap((group) => group.entries), ...properties, ...sharedLets, ...inline];
  const lastIndex = new Map<string, number>();
  inScope.forEach((entry, index) => lastIndex.set(entry.name, index));
  inScope.forEach((entry, index) => {
    entry.shadowed = lastIndex.get(entry.name) !== index;
  });
}

/** Build the render tree from the evaluation-oriented collections. Nodes appear in scope order:
 *  imports, frontmatter (+ skipped), then every block in document order, then the inline spans. */
function buildNodes(
  imports: ImportScope[],
  properties: { rootEntries: ScopeEntry[]; objectNodes: ScopeNode[]; },
  skips: SkipEntry[],
  blocks: BlockScope[],
  blockRanges: { openLine: number; closeLine: number; }[],
  inline: ScopeEntry[],
  prelude: PreludeScope[],
): ScopeNode[] {
  const nodes: ScopeNode[] = [];

  // The user prelude sits first — the ambient foundation every other binding is layered on. One
  // child node per `.nbt` file, in the order they are loaded into the interpreter (the settings
  // order, via `preludeFileList`).
  if (prelude.length > 0) {
    nodes.push({
      id: "prelude",
      kind: "prelude",
      label: "User prelude",
      badge: null,
      range: null,
      entries: [],
      skips: [],
      children: prelude.map((file) => ({
        id: `prelude:${file.path}`,
        kind: "prelude-file",
        label: file.label,
        badge: null,
        range: null,
        entries: file.entries,
        skips: [],
        children: [],
      })),
    });
  }

  if (imports.length > 0) {
    nodes.push({
      id: "imports",
      kind: "imports",
      label: "Imports",
      badge: null,
      range: null,
      entries: [],
      skips: [],
      children: imports.map((group) => ({
        id: `import:${group.notePath}`,
        kind: "import-note",
        label: importLabel(group.notePath),
        badge: null,
        range: null,
        entries: group.entries,
        skips: [],
        children: [],
      })),
    });
  }

  const { rootEntries, objectNodes } = properties;
  if (rootEntries.length > 0 || objectNodes.length > 0 || skips.length > 0) {
    // Object sub-trees first, then the skips — an error list reads better last, and it stays a
    // single flat list at any depth.
    const children: ScopeNode[] = [...objectNodes];
    if (skips.length > 0) {
      children.push({
        id: "skipped",
        kind: "skipped",
        label: "Skipped",
        badge: String(skips.length),
        range: null,
        entries: [],
        skips,
        children: [],
      });
    }

    nodes.push({
      id: "frontmatter",
      kind: "frontmatter",
      label: "Frontmatter",
      badge: null,
      range: null, // set by the caller from the note's frontmatter region
      entries: rootEntries,
      skips: [],
      children,
    });
  }

  blocks.forEach((block, index) => {
    const range = blockRanges[index];

    // 1-indexed fence-to-fence line span, as the editor's gutter shows it.
    const lines = `L${range.openLine + 1}-${range.closeLine + 1}`;
    nodes.push({
      id: `block:${index}`,
      kind: "block",
      label: block.exported ? `Shared block (${lines})` : `Block (${lines})`,
      badge: block.exported ? null : "local",
      range: { fromLine: range.openLine, toLine: range.closeLine },
      entries: block.statements.map((statement) => statement.entry).filter((entry): entry is ScopeEntry =>
        entry !== null
      ),
      skips: [],
      children: [],
    });
  });

  if (inline.length > 0) {
    nodes.push({
      id: "inline",
      kind: "inline",
      label: "Inline",
      badge: null,
      range: null,
      entries: inline,
      skips: [],
      children: [],
    });
  }

  return nodes;
}

/** A source note's display label — its basename without the `.md` extension. */
function importLabel(notePath: string): string {
  const base = notePath.split("/").pop() ?? notePath;
  return base.replace(/\.md$/, "");
}

// BUILDING THE TREE
// ================================================================================================

/** Build the note-scope tree from a derived preamble, the imports grouped by source note, the
 *  note's raw lines, and the inline config. Pure — values are filled in by scope/eval.ts. */
export function buildScopeTree(input: {
  file: string;
  lines: string[];
  config: InlineEvalConfig;
  preamble: NotePreamble;
  importGroups: { notePath: string; chunks: string[]; }[];
  preludeFiles?: PreludeFileLines[];
  /** `interpreterGeneration()`, folded into the tree's signature so a prelude edit or a change to
   *  the exchange rates invalidates cached values. Defaults to 0 for trees built in isolation
   *  (tests), where there is no interpreter to track. */
  generation?: number;
}): ScopeTree {
  const { file, lines, config, preamble, importGroups, preludeFiles = [], generation = 0 } = input;

  const imports = buildImports(importGroups);
  const properties = buildProperties(preamble, lines);
  const blocks = buildBlocks(lines);
  const units = scanNote(lines, config);
  const { entries: inline, lines: inlineLines } = buildInline(units);
  const prelude = buildPrelude(preludeFiles);

  markShadows(imports, properties.entries, blocks, inline);

  const nodes = buildNodes(imports, properties, preamble.skips, blocks, blocks, inline, prelude);

  // The frontmatter node's range is its YAML region (so the caret being in frontmatter makes it the
  // current node).
  const fmRange = frontmatterRange(lines);
  const fmNode = nodes.find((node) => node.kind === "frontmatter");
  if (fmNode !== undefined && fmRange !== null) {
    fmNode.range = fmRange;
  }

  const empty = imports.length === 0 && properties.entries.length === 0 && preamble.skips.length === 0
    && blocks.length === 0 && inline.length === 0 && prelude.length === 0;

  return {
    file,
    nodes,
    imports,
    properties: properties.entries,
    blocks,
    inline,
    prelude,
    units,
    preamble,
    inlineLines,
    // The value-cache key. noteSignature covers the interpreter generation (the user prelude and
    // the exchange rates), the preamble (properties + imports) and the units (shared blocks +
    // inline spans), but NOT plain `numbat` block bodies — they are absent from scanNote — so those
    // are appended. The prelude file contents are appended too: `buildDocumentScopeTree` builds one
    // tree per prelude file at the *same* generation, each seeing only the files ahead of it, and
    // only their contents tell those trees apart.
    signature: [
      noteSignature(generation, preamble.source, units, config),
      ...blocks.filter((block) => !block.exported).map((block) => block.wholeBody),
      ...preludeFiles.map((preludeFile) => preludeFile.lines.join("\n")),
    ]
      .join(String.fromCharCode(0)),
    empty,
  };
}

/**
 * The scope tree for a standalone `.nbt` file — the same shape the inspector already renders, with
 * the file standing in for a note.
 *
 * A Numbat file *is* a block body without the fence, so its declarations come from the same {@link
 * blockStatements} a fenced block uses and its values fill in through the same `evaluateScopeTree`.
 * There is no frontmatter, no import, and no inline span to model — only the file, and the
 * user-prelude files loaded ahead of it (`preludeFiles`), which are what its own names resolve
 * against.
 */
export function buildDocumentScopeTree(input: {
  file: string;
  label: string;
  lines: string[];
  preludeFiles?: PreludeFileLines[];
}): ScopeTree {
  const { file, label, lines, preludeFiles = [] } = input;
  const statements = blockStatements(lines, 0, "file");
  const entries = statements.map((statement) => statement.entry).filter((entry): entry is ScopeEntry => entry !== null);
  const prelude = buildPrelude(preludeFiles);

  // Within one file the last binding of a name wins, exactly as it does in scope.
  const lastIndex = new Map<string, number>();
  entries.forEach((entry, index) => lastIndex.set(entry.name, index));
  entries.forEach((entry, index) => {
    entry.shadowed = lastIndex.get(entry.name) !== index;
  });

  const blocks: BlockScope[] = [{
    exported: true,
    openLine: 0,
    closeLine: Math.max(lines.length - 1, 0),
    wholeBody: lines.join("\n"),
    statements,
  }];

  const nodes = buildNodes([], { rootEntries: [], objectNodes: [] }, [], [], [], [], prelude);
  nodes.push({
    id: "file",
    kind: "file",
    label,
    badge: null,
    // The whole file is the node's range, so the caret is always "in" it.
    range: { fromLine: 0, toLine: Math.max(lines.length - 1, 0) },
    entries,
    skips: [],
    children: [],
  });

  return {
    file,
    nodes,
    imports: [],
    properties: [],
    blocks,
    inline: [],
    prelude,
    units: [],
    preamble: EMPTY_PREAMBLE,
    inlineLines: [],
    // The file's own text and the prelude ahead of it are the whole of its scope.
    signature: [lines.join("\n"), ...preludeFiles.map((preludeFile) => preludeFile.lines.join("\n"))]
      .join(String.fromCharCode(0)),
    empty: entries.length === 0 && prelude.length === 0,
  };
}

// QUERYING THE TREE
// ================================================================================================

/** Every binding in the tree, in a fixed order (imports, properties, block statements, inline,
 *  prelude) — the positional basis for caching values by signature. */
export function scopeEntries(tree: ScopeTree): ScopeEntry[] {
  return [
    ...tree.imports.flatMap((group) => group.entries),
    ...tree.properties,
    ...tree.blocks.flatMap((block) =>
      block.statements.map((statement) => statement.entry).filter((entry): entry is ScopeEntry => entry !== null)
    ),
    ...tree.inline,
    ...tree.prelude.flatMap((file) => file.entries),
  ];
}

/**
 * The id of the node whose source range contains 0-indexed `caretLine` — the node the caret is
 * "in", auto-expanded and highlighted as current — or `null` when the caret is outside every node
 * (prose, or no editor). Blocks and the frontmatter region are contiguous; an inline span matches
 * when the caret is on its line.
 */
export function currentNodeId(tree: ScopeTree, caretLine: number | null): string | null {
  const trail = currentNodePath(tree, caretLine);
  return trail.length === 0 ? null : trail[trail.length - 1];
}

/**
 * The ids of the node the caret is in *and* every node containing it, outermost first — so the view
 * can expand the whole chain rather than a nested node whose parent stays collapsed and hides it.
 * Empty when the caret is in no node.
 *
 * The deepest match wins: a caret inside a `costs:` object is in that object, not merely in
 * Frontmatter. Only frontmatter objects nest ranges today, so for every other tree this returns
 * exactly what a flat scan of `tree.nodes` returned.
 */
export function currentNodePath(tree: ScopeTree, caretLine: number | null): string[] {
  if (caretLine === null) {
    return [];
  }

  const descend = (nodes: readonly ScopeNode[]): string[] => {
    for (const node of nodes) {
      if (node.range === null || caretLine < node.range.fromLine || caretLine > node.range.toLine) {
        continue;
      }
      return [node.id, ...descend(node.children)];
    }
    return [];
  };

  const trail = descend(tree.nodes);
  if (trail.length > 0) {
    return trail;
  }

  return tree.inlineLines.includes(caretLine) ? ["inline"] : [];
}

// GO TO DEFINITION
// ================================================================================================

/** What {@link findDefinition} resolved a hovered name to: where to go, and how to describe the
 *  place in the popup's link. */
export interface DefinitionMatch {
  /** Where to jump to. */
  defsite: DefSite;

  /** The binding, when the name resolved to one; `null` for an object *node* (a frontmatter object
   *  has a key to jump to but binds nothing itself). */
  entry: ScopeEntry | null;

  /** A short description of where it is — `Frontmatter`, `Shared block`, the source note's name —
   *  for the link's trailing detail. */
  where: string;
}

/** How a binding's source reads in a definition link. */
const SOURCE_LABEL: Record<ScopeSourceKind, string> = {
  import: "imported",
  property: "frontmatter",
  number: "frontmatter",
  shared: "shared block",
  local: "block",
  inline: "inline",
  prelude: "user prelude",
  file: "this file",
};

/**
 * Where the name under the cursor is defined, or `null` when the note's scope does not define it —
 * which is exactly what makes a symbol "bundled": everything from Numbat's own prelude is absent
 * from this tree, so it needs no separate notion.
 *
 * `probe` is the whole member chain (`costs.total`) and `name` the bare word; the chain is tried
 * first, so hovering a nested property's leaf goes to *that* key rather than to the object's. Among
 * several bindings of one name the nearest definition at or above `line` in this note wins (that is
 * the one in scope where the cursor is); failing that, the last one that is not shadowed; failing
 * that, the last. A name that only exists as a frontmatter *object* resolves to the object's key
 * line, so hovering `costs` still goes somewhere useful.
 */
export function findDefinition(
  tree: ScopeTree,
  probe: string,
  name: string,
  line: number | null,
): DefinitionMatch | null {
  const entries = scopeEntries(tree);
  const matches = (wanted: string) => entries.filter((entry) => entry.name === wanted || entry.label === wanted);
  const candidates = matches(probe).length > 0 ? matches(probe) : probe === name ? [] : matches(name);

  const entry = pickBinding(candidates, line);
  if (entry !== null) {
    return { defsite: entry.defsite, entry, where: SOURCE_LABEL[entry.sourceKind] };
  }

  const node = findObjectNode(tree.nodes, `property:${probe}`) ?? findObjectNode(tree.nodes, `property:${name}`);
  if (node !== null && node.range !== null) {
    return { defsite: { notePath: null, line: node.range.fromLine, ch: 0 }, entry: null, where: "frontmatter" };
  }

  return null;
}

/** The binding among `candidates` that is authoritative at `line` (see {@link findDefinition}), or
 *  `null` when there are none. */
function pickBinding(candidates: readonly ScopeEntry[], line: number | null): ScopeEntry | null {
  if (candidates.length === 0) {
    return null;
  }

  if (line !== null) {
    const above = candidates.filter((entry) =>
      entry.defsite.notePath === null && entry.defsite.line !== null && entry.defsite.line <= line
    );
    if (above.length > 0) {
      return above.reduce((best, entry) => (entry.defsite.line ?? 0) > (best.defsite.line ?? 0) ? entry : best);
    }
  }

  const live = candidates.filter((entry) => !entry.shadowed);
  const from = live.length > 0 ? live : candidates;
  return from[from.length - 1];
}

/** The `frontmatter-object` node with `id`, searched depth-first (objects nest). */
function findObjectNode(nodes: readonly ScopeNode[], id: string): ScopeNode | null {
  for (const node of nodes) {
    if (node.id === id && node.kind === "frontmatter-object") {
      return node;
    }

    const child = findObjectNode(node.children, id);
    if (child !== null) {
      return child;
    }
  }
  return null;
}

// RENDERING HELPERS
// ================================================================================================

/**
 * A declaration's head as Numbat formatter HTML — `unit U` / `dimension D`, the keyword colored as
 * a keyword and the declared name as a unit or a dimension, so a row reads the way the same
 * declaration reads in the editor. Rendering goes through `setNumbatHtml`, whose refinement pass
 * turns the `type-identifier` span following a `dimension` keyword into a dimension.
 *
 * `null` for `let` and `fn`, which carry no keyword in the inspector: a `let` row is just its name,
 * and a `fn` row shows its `type(…)` signature instead.
 */
export function declarationHeadHtml(entry: ScopeEntry): string | null {
  const name = escapeHtml(entry.label);
  switch (entry.declKind) {
    case "unit":
      return `<span class="numbat-keyword">unit</span> <span class="numbat-unit">${name}</span>`;
    case "dimension":
      return `<span class="numbat-keyword">dimension</span> <span class="numbat-type-identifier">${name}</span>`;
    default:
      return null;
  }
}

/**
 * Whether `entry` is declared on 0-indexed `caretLine` of the note the tree was built for — the
 * "active line" the caret sits on, highlighted in the inspector. A binding from another file (an
 * import, a prelude file) is never active: its defsite carries that file's `notePath`, while a
 * same-note defsite carries `null`. A caret on a bracketed statement's continuation line matches
 * nothing — the defsite is the line the declaration opens on — and the containing node's own
 * highlight carries it instead.
 */
export function isActiveLine(entry: ScopeEntry, caretLine: number | null): boolean {
  return caretLine !== null && entry.defsite.notePath === null && entry.defsite.line === caretLine;
}
