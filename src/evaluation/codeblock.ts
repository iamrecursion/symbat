// Renders `numbat` and `numbat-shared` fenced code blocks in both reading view and live preview.
//
//   * `numbat` — each block is evaluated in its own fresh context.
//   * `numbat-shared` — all `numbat-shared` blocks in the note share state. To keep results
//     deterministic (independent of the order Obsidian happens to render blocks in), every render
//     rebuilds a fresh context and replays all earlier `numbat-shared` blocks in document order
//     before evaluating this one.
//
// Both kinds open with the note preamble — the property-derived bindings (see properties/note.ts) —
// replayed into the fresh context before the block itself.

import { type MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { extractSharedBlocks } from "../document/shared-blocks";
import { escapeHtml } from "../interpreter/markup";
import {
  createContext,
  describeError,
  ensureNumbatReady,
  freeQuietly,
  interpret,
  type NumbatResult,
  restartNumbat,
} from "../interpreter/numbat";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import {
  type NotePreamble,
  preambleForDoc,
  preambleForFile,
  primeReservedNames,
  replayPreamble,
} from "../properties/note";

/**
 * Evaluate a `numbat-shared` block deterministically: build a fresh context and replay every
 * `numbat-shared` block that precedes this one in the note, then evaluate and return the result of
 * this block. Falls back to independent evaluation if the surrounding document text is unavailable.
 *
 * @param plugin The plugin instance (for settings).
 * @param source This block's source text.
 * @param el The element Obsidian rendered the block into.
 * @param ctx The post-processor context (provides the document text/position).
 * @returns The interpreter result for this block.
 */
function evaluateShared(
  plugin: SymbatPlugin,
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  preamble: NotePreamble,
): NumbatResult {
  const applyRates = plugin.settings.fetchExchangeRates;
  const info = ctx.getSectionInfo(el);
  if (!info) {
    // No document context available — fall back to independent evaluation.
    const context = createContext(applyRates);
    try {
      replayPreamble(context, preamble);
      return interpret(context, source);
    } finally {
      // As in the branch below: a wasm panic in the replay must not leak the context, which the
      // caller's catch would otherwise abandon.
      freeQuietly(context);
    }
  }

  const blocks = extractSharedBlocks(info.text);
  let current = blocks.findIndex((b) => b.startLine === info.lineStart);
  if (current === -1) {
    current = blocks.findIndex((b) => b.content === source);
  }

  const context = createContext(applyRates);
  try {
    replayPreamble(context, preamble);
    if (current === -1) {
      return interpret(context, source);
    }
    for (let i = 0; i < current; i += 1) {
      interpret(context, blocks[i].content);
    }
    return interpret(context, blocks[current].content);
  } finally {
    freeQuietly(context);
  }
}

/** Render an interpreter result into the block element (error-styled on error). */
function renderInto(el: HTMLElement, result: NumbatResult): void {
  const container = el.createDiv({ cls: "numbat-block" });
  const output = container.createEl("pre", { cls: "numbat-output" });
  if (result.isError) {
    output.addClass("numbat-error");
  }
  setNumbatHtml(output, result.output);
}

/**
 * Register the `numbat` and `numbat-shared` code-block processors. Each renders in both reading
 * view and live preview; the interpreter (and, if enabled, exchange rates) initialize lazily on the
 * first block rendered.
 */
export function registerCodeBlocks(plugin: SymbatPlugin): void {
  // `shared` selects independent (false) vs note-shared (true) evaluation.
  const handler = (shared: boolean) => {
    return async (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      ctx.addChild(new MarkdownRenderChild(el));
      let result: NumbatResult;
      try {
        await ensureNumbatReady();
        await plugin.ensureExchangeRates();
        await plugin.ensurePrelude();
        primeReservedNames(plugin.settings.fetchExchangeRates);

        // The note preamble (property bindings) opens the scope of every block, independent and
        // shared alike — from the section's document text when Obsidian provides it
        // (buffer-accurate), else the metadata cache.
        const info = ctx.getSectionInfo(el);
        const preamble = info !== null
          ? preambleForDoc(plugin, info.text, ctx.sourcePath)
          : preambleForFile(plugin, ctx.sourcePath);

        if (shared) {
          result = evaluateShared(plugin, source, el, ctx, preamble);
        } else {
          const context = createContext(plugin.settings.fetchExchangeRates);
          replayPreamble(context, preamble);
          result = interpret(context, source);
          freeQuietly(context);
        }
      } catch (error) {
        // Surface any crash (wasm load, context creation, panic) as an error and schedule a restart
        // so the next render reinitializes the interpreter.
        restartNumbat();
        result = { output: escapeHtml(`Numbat crashed and will restart: ${describeError(error)}`), isError: true };
      }

      renderInto(el, result);
    };
  };

  plugin.registerMarkdownCodeBlockProcessor("numbat", handler(false));
  plugin.registerMarkdownCodeBlockProcessor("numbat-shared", handler(true));
}
