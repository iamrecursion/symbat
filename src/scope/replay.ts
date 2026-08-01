// What a *position* in a note can see: the Numbat code to replay so that the names in scope there —
// the note's imports, its property bindings, the block above the cursor, the earlier inline spans —
// resolve.
//
// Two surfaces need exactly this and must not drift apart: the editor's expression completer
// (completion/suggest.ts), which asks "what is in scope so far", and the hover (hover/hover.ts),
// which asks "what is this name". They differ in one flag — `includeCurrentLine`, see {@link
// replayChunksAt} — and in nothing else.
//
// The chunks are fed to `ensureBlockCompletion`, which interprets each one independently and
// absorbs errors, so a half-written statement never wipes the definitions that did parse.

import { type App, type Editor, type EditorPosition } from "obsidian";
import { numbatFenceContext } from "../document/fences";
import { FRONTMATTER_CLOSE, FRONTMATTER_OPEN } from "../document/frontmatter";
import { extractSharedBlocks } from "../document/shared-blocks";
import { inlineConfig, inlineSpanAtCursor } from "../evaluation/inline";
import { findInlineSpans, scanNote } from "../evaluation/inline-parse";
import type SymbatPlugin from "../main";
import {
  frontmatterBody,
  isNumbatTypedKey,
  notePreamble,
  primeReservedNames,
  scopeChunksAbove,
} from "../properties/note";
import { propertyValueAt, type PropertyValueSite } from "../properties/parse";

// The frontmatter delimiters, as properties/parse.ts tracks them.

/**
 * The Numbat-typed property whose value `position` sits in, or `null`. This is the third position
 * where a note's text is Numbat source, beside a `numbat` fence and an inline span: a property's
 * value *is* an expression, and since nested properties are reached by a dotted path it is where
 * the completer and the hover help most.
 *
 * Untyped properties are excluded deliberately — a plain number has nothing to say and a prose
 * property is not Numbat code. `preceding` (the lines above the position) is taken when the caller
 * already has them, keeping the whole check off the keystroke path for every position that is not
 * inside frontmatter.
 */
export function numbatPropertySiteAt(
  app: App,
  editor: Editor,
  position: EditorPosition,
  preceding?: readonly string[],
): PropertyValueSite | null {
  const above = preceding ?? linesAbove(editor, position.line);
  if (above.length === 0 || !FRONTMATTER_OPEN.test(above[0])) {
    return null;
  }
  if (above.slice(1).some((line) => FRONTMATTER_CLOSE.test(line))) {
    return null; // the frontmatter closed above the position
  }

  // Only now is reading the whole note worth it — and the key sites need the closing delimiter,
  // which sits below.
  const site = propertyValueAt(editor.getValue().split("\n"), position.line, position.ch);
  return site !== null && isNumbatTypedKey(app, site.key) ? site : null;
}

/** The document lines strictly above `line`. */
function linesAbove(editor: Editor, line: number): string[] {
  const above: string[] = [];
  for (let n = 0; n < line; n += 1) {
    above.push(editor.getLine(n));
  }
  return above;
}

/** How {@link replayChunksAt} treats the line the position is on. */
export interface ReplayOptions {
  /**
   * Replay the position's own line (or, in an inline span, its own expression) as a final chunk.
   *
   * Completion leaves it out: it asks what is in scope *so far*, and the line is half-typed. A
   * hover wants it in — hovering `speed` on its own `let speed = …` line must resolve the name, and
   * that line falls below the completion cut.
   */
  includeCurrentLine?: boolean;
}

/**
 * The code chunks to replay so the names at `position` resolve: the note's cross-note imports and
 * property bindings (the preamble — replayed everywhere, mirroring evaluation), then the current
 * block's body above the position and — for a `numbat-shared` block — the preceding shared blocks
 * in the note, in document order (mirroring how a shared block is actually evaluated).
 *
 * In an inline-eval span the replay instead mirrors the inline evaluator: every `numbat-shared`
 * block and every earlier inline expression, in document order. In a Numbat-typed property's value
 * it is that property's own scope — the imports and the properties above it, never the ones below
 * and never the note's blocks.
 *
 * Empty when the position is at the top of a block in a property-less note, keeping that case on
 * the prelude-only fast path.
 */
export function replayChunksAt(
  plugin: SymbatPlugin,
  editor: Editor,
  notePath: string | null,
  position: EditorPosition,
  options: ReplayOptions = {},
): string[] {
  const { includeCurrentLine = false } = options;
  // Property bindings open the note's scope everywhere, so they replay first on every path. The
  // whole frontmatter is used — the preamble is note-global, and it always sits above any Numbat
  // code.
  primeReservedNames(plugin.settings.fetchExchangeRates);
  const preamble = notePreamble(plugin, frontmatterBody(editor.getValue().split("\n")), notePath);

  const propertySite = numbatPropertySiteAt(plugin.app, editor, position);
  if (propertySite !== null) {
    return scopeChunksAbove(preamble, propertySite.key);
  }

  // Cross-note imports open the scope before the note's own property bindings.
  const chunks: string[] = [...(preamble.imports ?? [])];
  chunks.push(...preamble.bindings.map((binding) => binding.code));

  const before = linesAbove(editor, position.line);
  const fence = numbatFenceContext(before);
  if (fence !== null) {
    if (fence.shared) {
      for (const block of extractSharedBlocks(editor.getValue())) {
        if (block.startLine < fence.openLine) {
          chunks.push(block.content);
        }
      }
    }

    if (fence.body.length > 0) {
      chunks.push(fence.body.join("\n"));
    }

    if (includeCurrentLine) {
      chunks.push(editor.getLine(position.line));
    }

    return chunks;
  }

  const span = inlineSpanAtCursor(plugin, editor, position);
  if (span === null) {
    return chunks;
  }

  const config = inlineConfig(plugin);
  for (const unit of scanNote(before, config)) {
    chunks.push(unit.kind === "shared" ? unit.code : unit.span.expr);
  }

  // Spans earlier on the position's own line replay too (scanNote saw only the lines above it).
  for (const earlier of findInlineSpans(editor.getLine(position.line), config)) {
    if (earlier.closeEnd <= span.prefixStart) {
      chunks.push(earlier.expr);
    }
  }

  if (includeCurrentLine) {
    chunks.push(span.expr);
  }

  return chunks;
}
