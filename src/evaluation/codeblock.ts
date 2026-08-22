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
//
// This module reads the document and paints the answer; what it never does any more is hold the
// context in between. What crosses is the block's own source and the list of shared blocks that
// open its scope, which is exactly the information the determinism argument above rests on.

import { type MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { extractSharedBlocks } from "../document/shared-blocks";
import { escapeHtml } from "../interpreter/markup";
import {
  ask,
  describeError,
  ensureNumbatReady,
  interpreterGeneration,
  type NumbatResult,
  restartNumbat,
} from "../interpreter/numbat";
import { refusalResult, rememberRefusal } from "../interpreter/refusals";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { ensureReservedNames, type NotePreamble, preambleForDoc, preambleForFile } from "../properties/note";

/**
 * What one block asks to have evaluated: its own source, and the `numbat-shared` blocks that must
 * be replayed ahead of it.
 *
 * Derived here rather than where the evaluation happens, because it is a question about the
 * *document* (where this block sits among the note's shared ones) and the document is on this side
 * of the boundary.
 */
function sharedScope(
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): { source: string; before: string[]; } {
  const info = ctx.getSectionInfo(el);
  if (!info) {
    // No document context available — fall back to independent evaluation.
    return { source, before: [] };
  }

  const blocks = extractSharedBlocks(info.text);
  let current = blocks.findIndex((b) => b.startLine === info.lineStart);
  if (current === -1) {
    current = blocks.findIndex((b) => b.content === source);
  }
  if (current === -1) {
    return { source, before: [] };
  }

  return { source: blocks[current].content, before: blocks.slice(0, current).map((b) => b.content) };
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
 * What a block shows when the interpreter had no answer to give at all — it is down, or it is
 * being replaced. Deliberately not the limit's sentence, which would send the reader to a setting
 * that was never the problem.
 */
const UNAVAILABLE: NumbatResult = {
  output: escapeHtml("Numbat is restarting; this block will evaluate on the next render."),
  isError: true,
};

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
        void ensureReservedNames(plugin.settings.fetchExchangeRates);

        // A note that gave up recently is not tried again until the cool-down passes. The ledger
        // exists to prevent notes from retrying their whole budget on every render, turning one
        // stall into a series of them. It is stamped with the interpreter generation so prelude or
        // exchange rate changes are handled immediately.
        const refused = refusalResult(ctx.sourcePath, interpreterGeneration());
        if (refused !== null) {
          renderInto(el, refused);
          return;
        }

        // The note preamble (property bindings) opens the scope of every block, independent and
        // shared alike from the section's document text when Obsidian provides it
        // (buffer-accurate), else the metadata cache.
        const info = ctx.getSectionInfo(el);
        const preamble: NotePreamble = info !== null
          ? preambleForDoc(plugin, info.text, ctx.sourcePath)
          : preambleForFile(plugin, ctx.sourcePath);

        const scope = shared ? sharedScope(source, el, ctx) : { source, before: [] };

        // The note's evaluation allowance, covering all evaluation (incl. transitively) done by the
        // note. It is stated rather than armed here: a wall-clock deadline held across the request
        // would charge the note for the time the request spent waiting to be served.
        const budgeted = await ask("evalCodeBlock", {
          source: scope.source,
          before: scope.before,
          preamble,
          applyRates: plugin.settings.fetchExchangeRates,
          budget: { budgetMs: plugin.settings.evaluationLimitMs, key: ctx.sourcePath },
        }, { note: ctx.sourcePath });

        if (budgeted === null) {
          renderInto(el, UNAVAILABLE);
          return;
        }

        // Only a genuine refusal is filed, never a slow-but-complete render: `exceeded` is false
        // for work that merely finished late, which is what keeps the ledger from holding out a
        // note that was answering perfectly well.
        if (budgeted.exceeded) {
          rememberRefusal(ctx.sourcePath, interpreterGeneration());
          plugin.reportEvaluationLimit(ctx.sourcePath);
        }

        result = budgeted.value;
      } catch (error) {
        // Surface any crash (wasm load, a request that could not be made) as an error and schedule
        // a restart so the next render reinitializes the interpreter.
        restartNumbat();
        result = { output: escapeHtml(`Numbat crashed and will restart: ${describeError(error)}`), isError: true };
      }

      renderInto(el, result);
    };
  };

  plugin.registerMarkdownCodeBlockProcessor("numbat", handler(false));
  plugin.registerMarkdownCodeBlockProcessor("numbat-shared", handler(true));
}
