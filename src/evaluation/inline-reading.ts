// Inline expression evaluation in reading view.
//
// A Markdown post-processor that finds rendered inline-eval spans — an inline `<code>` immediately
// preceded by the `n` / `nc` prefix — evaluates each against the note's shared state, and replaces
// it with the computed value (or `expression = value`, per the reading-view setting). The editor
// side lives in evaluation/inline.ts; this shares the same pure detection
// (evaluation/inline-parse.ts) and evaluation replay (evaluateNoteUnits), so both surfaces agree.
//
// Other plugins claim inline code too (Shiki's `{lang}` inline highlighting uses the same `{…}`
// marker a span uses for its config), so a span whose rendered text has been rewritten is resolved
// from the note's source instead — see collectMatches and the pairing in processInlineEval.

import type { MarkdownPostProcessorContext } from "obsidian";
import { ensureNumbatReady, interpreterGeneration, isNumbatReady, restartNumbat } from "../interpreter/numbat";
import { setNumbatHtml } from "../interpreter/render";
import type SymbatPlugin from "../main";
import { type NotePreamble, preambleForDoc, preambleForFile, primeReservedNames } from "../properties/note";
import { READING_EVAL_CACHE_ENTRIES } from "../tuning";
import { displayValueHtml, evaluateExprs, evaluateNoteUnits, inlineConfig } from "./inline";
import {
  configDecimalPlaces,
  configError,
  contentParts,
  type InlineEvalConfig,
  type InlineResult,
  noteSignature,
  type NoteUnit,
  scanNote,
  trailingPrefix,
} from "./inline-parse";

/** A small, bounded cache of whole-note evaluations, so the many sections of one reading-view
 *  render share a single replay. Keyed by the note's eval signature. */
const evalCache = new Map<string, InlineResult[]>();

/** A rendered inline-eval span located in the DOM. */
interface DomMatch {
  /** The `<code>` element to replace. */
  element: Element;

  /** The text node holding the `n` / `nc` prefix (immediately before the span). */
  prefixNode: Text;

  /** How many characters of `prefixNode` are the prefix (to strip). */
  prefixLen: number;

  /** Whether the span recomputes on every render (`live`, the `n` prefix) or is written back into
   *  the note once evaluated (`concrete`, the `nc` prefix). */
  variant: "live" | "concrete";

  /** The expression to evaluate (content past a `{…}` config and left of the separator, trimmed),
   *  or `null` when the rendered element no longer carries it — then the note's source supplies it,
   *  by position. */
  expr: string | null;

  /** The decimal places the span displays with (its config's `dp`, else the default), or `null` for
   *  full precision. */
  dp: number | null;

  /** The `{…}` config's syntax error, when malformed (the span then renders raw). */
  configError: string | null;
}

// REGISTRATION
// ================================================================================================

/** Register the reading-view inline-evaluation post-processor. */
export function registerInlineEvalReading(plugin: SymbatPlugin): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    void processInlineEval(plugin, el, ctx);
  });
}

/**
 * Locate the inline-eval spans rendered into `el`, evaluate them (with the note's shared state when
 * the surrounding text is available), and replace each with its value. Errors and unmatched spans
 * are left as-is, so the reader still sees the raw expression rather than a broken value.
 */
async function processInlineEval(
  plugin: SymbatPlugin,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): Promise<void> {
  if (!plugin.settings.inlineEval) {
    return;
  }

  const config = inlineConfig(plugin);
  const matches = collectMatches(el, config);
  if (matches.length === 0) {
    return;
  }

  try {
    await ensureNumbatReady();
    await plugin.ensureExchangeRates();
    await plugin.ensurePrelude();
  } catch (error) {
    console.error("Symbat: inline evaluation (reading view) could not initialize the interpreter", error);
    return;
  }

  if (!isNumbatReady()) {
    return;
  }

  // Map each DOM match to a computed result — with full note context when the section text is
  // available, else evaluating the matches in isolation (still opened by the note preamble, read
  // from the metadata cache). The expression is carried alongside, since a span another plugin
  // rewrote has none of its own.
  const resultOf = new Map<DomMatch, { result: InlineResult; expr: string; }>();
  const info = ctx.getSectionInfo(el);
  primeReservedNames(plugin.settings.fetchExchangeRates);

  try {
    if (info) {
      const units = scanNote(info.text.split("\n"), config);
      const preamble = preambleForDoc(plugin, info.text, ctx.sourcePath);
      const results = evaluateCached(units, plugin.settings.fetchExchangeRates, config, preamble);
      const sectionInline = inlineUnitsInRange(units, info.lineStart, info.lineEnd);

      matches.forEach((match, index) => {
        const entry = sectionInline[index];
        if (entry === undefined) {
          return;
        }

        // The by-order pairing is guarded by an expression check, so a desync leaves the span
        // untouched rather than showing the wrong value. A span another plugin has rewritten has no
        // expression to check against — the source is then the only account of it, and position is
        // all we have.
        if (match.expr !== null && match.expr !== entry.unit.span.expr) {
          return;
        }
        const result = results[entry.index];

        if (result !== undefined) {
          resultOf.set(match, { result, expr: entry.unit.span.expr });
        }
      });
    } else {
      // No section text: only spans that still carry their own expression can be evaluated at all.
      const readable = matches.filter((match) => match.expr !== null);
      const results = evaluateExprs(
        readable.map((m) => ({ expr: m.expr as string, dp: m.dp, error: m.configError })),
        plugin.settings.fetchExchangeRates,
        preambleForFile(plugin, ctx.sourcePath),
      );
      readable.forEach((match, index) => {
        const result = results[index];
        if (result !== undefined) {
          resultOf.set(match, { result, expr: match.expr as string });
        }
      });
    }
  } catch (error) {
    console.error("Symbat: inline evaluation (reading view) crashed", error);
    restartNumbat();
    return;
  }

  const style = plugin.settings.inlineEvalReadingStyle;
  for (const match of matches) {
    const resolved = resultOf.get(match);

    if (resolved === undefined || resolved.result.kind !== "value") {
      // Only a value replaces the span; an error, hole, or declaration leaves the rendered span
      // (and its prefix) in place — a binding's text is the content.
      continue;
    }
    const valueHtml = displayValueHtml(resolved.result);

    // Empty HTML is treated as no value: replacing the span with nothing would delete the
    // expression from view and leave no clue that it ever evaluated.
    if (valueHtml === null || valueHtml === "") {
      continue;
    }

    render(match, valueHtml, style, resolved.expr);
  }
}

// FINDING SPANS IN THE DOM
// ================================================================================================

/**
 * Find every inline-eval span rendered into `el`: an inline `<code>` (not inside a `<pre>` fenced
 * block) whose preceding text node ends with a trigger prefix.
 *
 * A span whose content is *empty* is kept rather than skipped, because other plugins claim inline
 * code too and may have rewritten it before we look. Shiki, for one, reads a leading `{…}` as a
 * language marker for inline highlighting — the same syntax a span uses for its config — so ``
 * nc`{dp=} 1 + 1` `` arrives with its text replaced. The expression is then unreadable here, but
 * the note's source still has it, and {@link processInlineEval} resolves it by position.
 */
function collectMatches(el: HTMLElement, config: InlineEvalConfig): DomMatch[] {
  const matches: DomMatch[] = [];
  for (const code of Array.from(el.querySelectorAll("code"))) {
    if (code.closest("pre")) {
      continue; // A fenced code block, not inline code.
    }

    const prev = code.previousSibling;
    if (prev === null || prev.nodeType !== Node.TEXT_NODE) {
      continue;
    }

    const prefixNode = prev as Text;
    const prefix = trailingPrefix(prefixNode.data, config);
    if (prefix === null) {
      continue;
    }

    const { expr, configText } = contentParts(code.textContent ?? "", prefix.variant, config);
    matches.push({
      element: code,
      prefixNode,
      prefixLen: prefix.len,
      variant: prefix.variant,
      // An empty span is kept, not dropped: another plugin may have rewritten its contents, and the
      // note's source still knows what it said.
      expr: expr === "" ? null : expr,
      dp: configDecimalPlaces(configText, config),
      configError: configError(configText),
    });
  }

  return matches;
}

/** The inline units whose line falls within `[lineStart, lineEnd]`, each paired with its index
 *  among *all* inline units (so it maps into the results array). */
function inlineUnitsInRange(
  units: NoteUnit[],
  lineStart: number,
  lineEnd: number,
): { unit: Extract<NoteUnit, { kind: "inline"; }>; index: number; }[] {
  const inRange: { unit: Extract<NoteUnit, { kind: "inline"; }>; index: number; }[] = [];

  let index = -1;
  for (const unit of units) {
    if (unit.kind !== "inline") {
      continue;
    }

    index += 1;

    if (unit.line >= lineStart && unit.line <= lineEnd) {
      inRange.push({ unit, index });
    }
  }

  return inRange;
}

// EVALUATION AND RENDERING
// ================================================================================================

/** Evaluate a note's units, reusing a cached result when its signature is unchanged. */
function evaluateCached(
  units: NoteUnit[],
  applyRates: boolean,
  config: InlineEvalConfig,
  preamble: NotePreamble,
): InlineResult[] {
  const signature = noteSignature(interpreterGeneration(), preamble.source, units, config);
  const cached = evalCache.get(signature);
  if (cached !== undefined) {
    return cached;
  }

  const results = evaluateNoteUnits(units, applyRates, config, preamble);
  evalCache.set(signature, results);

  while (evalCache.size > READING_EVAL_CACHE_ENTRIES) {
    const oldest = evalCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    evalCache.delete(oldest);
  }

  return results;
}

/** Strip the prefix from its text node and replace the rendered span with the value (or `expression
 *  = value`). */
function render(match: DomMatch, valueHtml: string, style: "value" | "expression", expr: string): void {
  match.prefixNode.data = match.prefixNode.data.slice(0, match.prefixNode.data.length - match.prefixLen);
  const out = createSpan({ cls: "numbat-inline-value" });

  if (style === "expression") {
    out.createSpan({ cls: "numbat-inline-expr", text: expr });
    out.appendText(" = ");
  }

  setNumbatHtml(out.createSpan(), valueHtml);
  match.element.replaceWith(out);
}
