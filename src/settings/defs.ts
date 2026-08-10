// What the settings *are*: the persisted shape, the defaults, the validators, and one descriptor
// per control — its label, its help text, what reveals it, and what has to be rebuilt when it
// changes.
//
// This exists because settings/tab.ts used to say all of that three times: once in
// `getSettingDefinitions()` for Obsidian 1.13's declarative API, once in `renderImperative()` for
// the `display()` fallback that older builds used, and a third time in `applySideEffect()` for the
// effects. Three copies of forty-two settings drifted, as three copies do, and produced two real
// bugs:
//
//   * `fetchExchangeRates` invalidated the completion vocabulary on one path and fetched the rates
//     on the other, so whichever path you were on did half the job;
//   * `hoverDelayMs` rebuilt the hover extension on the declarative path and did nothing on the
//     imperative one — and the imperative one was what shipped, so changing the hover delay had no
//     effect at all.
//
// The imperative renderer is gone (the plugin now requires the 1.13 settings API) and the effects
// moved here, so there is one description of each setting and nothing left to drift against. Being
// data — no closures, no Obsidian imports — it is also unit-testable, which settings/tab.ts never
// was.
//
// Two design choices carry that:
//
//   * `visibleWhen` is a settings **key**, not a predicate. Every one of the 21 dependent rows had
//     the shape `() => plugin.settings.someBoolean`; naming the key instead of closing over it is
//     what lets a test check that each one points at a real boolean setting.
//   * `effects` are **names**, not functions. Dispatching them is settings/tab.ts's job, which is
//     what keeps this file free of plugin imports.

// The indent bounds come from views/indent.ts rather than being spelled again here: the floor is
// not a preference but the point below which CodeMirror's `indentUnit` throws, so the two must
// agree. It is a constants-only import — still no Obsidian, and still unit-testable.
import { DEFAULT_INDENT_WIDTH, MAX_INDENT_WIDTH, MIN_INDENT_WIDTH } from "../views/indent";
// properties/zone.ts is imported for the same reason, though for two functions rather than for
// constants: what counts as a time zone is the platform's answer, not a list this file could keep,
// and asking the same module the bindings ask keeps the two from disagreeing about which zones
// exist. Its whole transitive closure is pure — `Intl` is a built-in — so this stays unit-testable.
import { knownZone, normalizeOffset } from "../properties/zone";
import { isValidCssFontSize, type PreludeFile } from "./util";

/** How the REPL input's Vim mode is decided: follow Obsidian's editor "Vim key bindings" setting,
 *  or force it on or off. */
export type ReplVimMode = "match" | "on" | "off";

/** How a rendered inline evaluation shows in reading view. */
export type InlineReadingStyle = "value" | "expression";

/** User-configurable settings, persisted through Obsidian's plugin data. */
export interface SymbatSettings {
  /** Fetch live currency exchange rates over the network (opt-in). */
  fetchExchangeRates: boolean;

  /** How often (in hours) cached exchange rates may be reused before a refetch. */
  exchangeRateRefreshHours: number;

  /** How long (in seconds) to wait for a rate fetch before falling back to the last rates cached on
   *  disk. */
  exchangeRateTimeoutSeconds: number;

  /** Load one or more `.nbt` prelude files into every context (master toggle). */
  customPrelude: boolean;

  /** The prelude files (name + vault path), loaded in this order. */
  preludeFiles: PreludeFile[];

  /** Expand LaTeX-style `\code` sequences (e.g. `\alpha` → `α`) as you type. */
  unicodeExpansion: boolean;

  /** The leader that introduces a unicode `\code` (default `\`). */
  unicodeLeader: string;

  /** Offer previous REPL inputs in a completer when the history leader is typed. */
  historyCompletion: boolean;

  /** The leader that opens the REPL history completer (default `?:`). */
  historyLeader: string;

  /** Autocomplete Numbat expressions (names, keywords, types, …) as you type. */
  exprCompletion: boolean;

  /** Include variable, constant, and function names in expression completion. */
  completeIdentifiers: boolean;

  /** Include keywords and operators in expression completion. */
  completeKeywords: boolean;

  /** Include unit names in expression completion. */
  completeUnits: boolean;

  /** Include physical dimension names in expression completion. */
  completeDimensions: boolean;

  /** Include built-in / structural type names in expression completion. */
  completeTypes: boolean;

  /** Show a symbol's documentation when it is hovered or dwelt on (master toggle). */
  hover: boolean;

  /** Open the hover popup when the mouse rests on a symbol. */
  hoverMouse: boolean;

  /** Open the hover popup when the *caret* rests on a symbol. Independent of {@link hoverMouse}: a
   *  popup that follows the cursor around is not to everyone's taste. Under Vim it applies in
   *  insert mode only — normal mode has {@link hoverVimKey}. */
  hoverDwell: boolean;

  /** How long the mouse or the caret must rest before the popup opens (ms). */
  hoverDelayMs: number;

  /** The Vim *normal-mode* key that opens the hover popup (default `H`); empty leaves normal mode
   *  entirely alone. */
  hoverVimKey: string;

  /** Show inline results and inferred type hints in numbat blocks (master toggle). */
  inlayHints: boolean;

  /** Show each expression's computed result at the end of its line. */
  inlayResults: boolean;

  /** Show inferred type hints: a binding's type after its name, and the expected type of an
   *  incomplete expression. */
  inlayTypes: boolean;

  /** Evaluate Numbat expressions written inline in prose, e.g. `` n`5 km + 3 mi` `` (master toggle
   *  for the whole inline-evaluation feature). */
  inlineEval: boolean;

  /** How a rendered (reading-view) inline evaluation shows: just the `value`, or the `expression`
   *  and value together. */
  inlineEvalReadingStyle: InlineReadingStyle;

  /** When committing an inline evaluation to text, keep the expression alongside the value (`expr =
   *  value`) rather than replacing it with the value alone. */
  inlineEvalRetainExpr: boolean;

  /** The prefix that marks a *live* inline evaluation (default `n`). */
  inlineEvalLivePrefix: string;

  /** The prefix that marks a *concrete* (auto-materialized) inline evaluation (default `nc`). */
  inlineEvalConcretePrefix: string;

  /** Default decimal places for inline results (digits), or `""` for full precision. A span's
   *  `{dp=…}` config overrides it. */
  inlineEvalDecimalPlaces: string;

  /** Evaluate inline expressions written in YAML frontmatter (note properties). Gated by {@link
   *  inlineEval}; results show while editing in Source mode. */
  inlineEvalFrontmatter: boolean;

  /** Evaluate inline expressions written inside non-`numbat` fenced code blocks. Gated by {@link
   *  inlineEval}; results show while editing in Source mode. */
  inlineEvalCodeBlocks: boolean;

  /** Note properties feed the note's Numbat scope (master toggle): a property assigned the
   *  **Numbat** type binds its value as an expression, replayed before every code block, inline
   *  span, and completion in the note. */
  noteProperties: boolean;

  /** Untyped properties whose value is a plain number also bind, as scalars. Gated by {@link
   *  noteProperties}. */
  notePropertyNumbers: boolean;

  /** Untyped properties whose value is text also bind, as Numbat strings. Gated by {@link
   *  noteProperties}. */
  notePropertyText: boolean;

  /** Properties without the Numbat type but assigned Obsidian's Date type bind as Numbat
   *  `DateTime`s. Gated by {@link noteProperties}. */
  notePropertyDates: boolean;

  /** Untyped properties whose value is a checkbox or toggle also bind, as Numbat booleans. Gated by
   *  {@link noteProperties}. */
  notePropertyBooleans: boolean;

  /** A `numbat-use` frontmatter property imports the named notes' `numbat-shared` blocks and typed
   *  properties into this note's scope. Gated by {@link noteProperties}. */
  noteImports: boolean;

  /** Spaces one Tab inserts in the `.nbt` file editor, and the stop Shift-Tab dedents back to. */
  nbtIndentWidth: number;

  /** Vim key bindings in the REPL input: follow Obsidian's editor setting, or force on/off. */
  replVimMode: ReplVimMode;

  /** Syntax-highlight the REPL input expression as it is typed. */
  liveReplHighlight: boolean;

  /** Override the REPL font sizes below (master toggle). */
  customReplFont: boolean;

  /** CSS size for the REPL output log (the "view"). */
  replViewFontSize: string;

  /** CSS size for the REPL input line. */
  replInputFontSize: string;

  /** Maximum number of REPL input-history entries to retain. */
  replHistoryLimit: number;

  /** Maximum number of visible lines kept in the REPL output log. */
  replMaxLines: number;

  /** Seconds of completion inactivity before the cached interpreters are freed (0 keeps them
   *  loaded). */
  completionIdleSeconds: number;

  /** The time zone a date, or a time written without an offset, is read in — an IANA name
   *  (`Europe/Berlin`) or a literal offset (`+02:00`). Blank means the reader's own zone. */
  notePropertyDefaultZone: string;
}

/** The CSS size the REPL fonts default to: the current theme's code size. */
export const DEFAULT_REPL_FONT_SIZE = "var(--code-size)";

/**
 * Every setting's default. Also the fallback each one is restored to when the persisted value is
 * missing or unusable — see `normalizeSettings`, which is what enforces that on read, since
 * Obsidian's declarative `validate` shows a message without replacing the stored value.
 */
export const DEFAULT_SETTINGS: SymbatSettings = {
  fetchExchangeRates: false,
  exchangeRateRefreshHours: 24,
  exchangeRateTimeoutSeconds: 10,
  customPrelude: false,
  preludeFiles: [],
  unicodeExpansion: true,
  unicodeLeader: "\\",
  historyCompletion: true,
  historyLeader: "?:",
  exprCompletion: true,
  completeIdentifiers: true,
  completeKeywords: true,
  completeUnits: true,
  completeDimensions: true,
  completeTypes: true,
  hover: true,
  hoverMouse: true,
  hoverDwell: true,
  hoverDelayMs: 400,
  hoverVimKey: "H",
  inlayHints: true,
  inlayResults: true,
  inlayTypes: true,
  inlineEval: true,
  inlineEvalReadingStyle: "value",
  inlineEvalRetainExpr: false,
  inlineEvalLivePrefix: "n",
  inlineEvalConcretePrefix: "nc",
  inlineEvalDecimalPlaces: "",
  inlineEvalFrontmatter: true,
  inlineEvalCodeBlocks: true,
  noteProperties: true,
  notePropertyNumbers: true,
  notePropertyText: true,
  notePropertyDates: true,
  notePropertyBooleans: true,
  noteImports: true,
  nbtIndentWidth: DEFAULT_INDENT_WIDTH,
  replVimMode: "match",
  liveReplHighlight: true,
  customReplFont: false,
  replViewFontSize: DEFAULT_REPL_FONT_SIZE,
  replInputFontSize: DEFAULT_REPL_FONT_SIZE,
  replHistoryLimit: 100,
  replMaxLines: 200,
  completionIdleSeconds: 60,
  notePropertyDefaultZone: "",
};

/** The settings keys whose value has a given type — derived, so a new setting cannot be left out of
 *  the union it belongs to. */
type KeysOfType<T> = {
  [K in keyof SymbatSettings]-?: SymbatSettings[K] extends T ? K : never;
}[keyof SymbatSettings];

/** Every boolean setting's key — the toggles, and what `visibleWhen` may name. */
export type BooleanSettingKey = KeysOfType<boolean>;

/** Every numeric setting's key — the ones `NUMBER_MINIMUMS` clamps on read. */
export type NumberSettingKey = KeysOfType<number>;

/** Free-text settings. Listed rather than derived, because the two dropdowns are also string-valued
 *  and are not free text. */
export type TextSettingKey =
  | "unicodeLeader"
  | "historyLeader"
  | "hoverVimKey"
  | "inlineEvalLivePrefix"
  | "inlineEvalConcretePrefix"
  | "inlineEvalDecimalPlaces"
  | "replViewFontSize"
  | "replInputFontSize"
  | "notePropertyDefaultZone";

// VALIDATORS
// ================================================================================================
//
// Each returns a message when the value is unusable, and `undefined` when it is fine.
//
// A validator is the *message*, not the enforcement. Obsidian is explicit about this
// (obsidian.d.ts): it "runs `validate` once on mount and shows the message if the seeded value
// fails; it does not modify or replace the stored value. Plugins that need to enforce invariants on
// stored data should validate again when reading their settings." That enforcement is {@link
// normalizeSettings}, which runs on load and on every write — so these define what the *user is
// told*, and it defines what the consumers actually see.

/** Validate a REPL font-size string. */
export function validateFontSize(value: string): string | undefined {
  if (!isValidCssFontSize(value)) {
    return "Enter a CSS size such as 14px, 0.9em, or var(--code-size).";
  }
  return undefined;
}

/** Validate a completer leader: non-empty and free of whitespace. */
export function validateLeader(value: string): string | undefined {
  if (value === "" || /\s/.test(value)) {
    return "Enter one or more non-space characters.";
  }
  return undefined;
}

/** Validate an inline-eval prefix: one or more letters (so it reads as a word before the code span,
 *  and never collides with punctuation or backticks). */
export function validatePrefix(value: string): string | undefined {
  if (!/^\p{L}+$/u.test(value)) {
    return "Enter one or more letters.";
  }
  return undefined;
}

/** Validate the default decimal places: blank (full precision) or a small non-negative integer — an
 *  f64 has nothing meaningful beyond 15 places. */
export function validateDecimalPlaces(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  if (!/^\d+$/.test(trimmed) || Number(trimmed) > 15) {
    return "Enter a whole number of decimal places (0–15), or leave blank.";
  }

  return undefined;
}

/** Validate a default time zone: blank (the reader's own), an IANA name the platform knows, or a
 *  literal UTC offset. */
export function validateTimeZone(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || normalizeOffset(trimmed) !== null || knownZone(trimmed)) {
    return undefined;
  }
  return "Enter a time zone such as Europe/Berlin or UTC, an offset such as +02:00, or leave blank.";
}

// DESCRIPTORS
// ================================================================================================

/**
 * Something that must be rebuilt after a setting changes, named rather than called so this table
 * stays free of plugin imports. settings/tab.ts maps each name onto the plugin method that performs
 * it, in one `switch` — the single place where "what changed" meets "what to do about it".
 */
export type SettingEffect =
  /** Fetch (or, when the toggle is off, clear) the live exchange rates. */
  | "ensureExchangeRates"
  /** Rebuild the shared completion context and the property reserved-name set, both of which bake
   *  in the current unit vocabulary. */

  | "invalidateCompletionVocabulary"
  /** Reload the user prelude into every interpreter context. */
  | "markPreludeDirty"
  | "refreshHover"
  /** Re-apply the Tab indent width to every open `.nbt` file editor. */
  | "refreshIndentWidth"
  | "refreshInlayHints"
  | "refreshInlineEval"
  | "refreshNoteScope"
  | "refreshReplFont"
  | "refreshReplHighlight"
  | "refreshReplVim";

/** The control a setting is edited through. */
export type SettingControl =
  | { type: "toggle"; key: BooleanSettingKey; }
  | {
    type: "number";
    key: NumberSettingKey;
    min: number;

    /** Optional: most numbers here have no natural ceiling, and inventing one would be a limit the
     *  user did not ask for. Declared where a large value is actively harmful rather than merely
     *  odd. */
    max?: number;
  }
  | {
    type: "text";
    key: TextSettingKey;
    placeholder?: string;
    /** Applied by *both* renderers; a failing value falls back to the default. */
    validate?: (value: string) => string | undefined;
  }
  | { type: "dropdown"; key: "replVimMode"; options: Record<ReplVimMode, string>; }
  | { type: "dropdown"; key: "inlineEvalReadingStyle"; options: Record<InlineReadingStyle, string>; };

/** One row of the settings tab. */
export interface SettingDescriptor {
  /** The row's title. */
  name: string;

  /** Help text. Backtick spans render as `<code>` — see settings/tab.ts's `descFragment`. */
  desc: string;

  /** Shown only while this boolean setting is on. A key rather than a predicate: the imperative
   *  renderer needs to know *which* toggle to re-render after. */
  visibleWhen?: BooleanSettingKey;

  /** The input to render, and the setting it reads and writes. */
  control: SettingControl;

  /** Applied in order once the new value is persisted. */
  effects?: readonly SettingEffect[];
}

/**
 * The settings tab, in render order. Two blocks are not uniform rows and are therefore positional
 * markers rather than descriptors: the prelude file list (reorderable, two fields per row, and
 * genuinely different affordances in the two APIs) and the version card.
 */
export type SettingBlock =
  | { kind: "group"; heading: string; settings: readonly SettingDescriptor[]; }
  | { kind: "prelude-list"; visibleWhen: BooleanSettingKey; }
  | { kind: "version-card"; };

/** Shared by both REPL font-size rows. */
const FONT_DESC = "A CSS size such as 14px, 0.9em, or var(--code-size).";

/**
 * The whole settings tab, declaratively. This is the single description of what the tab contains:
 * settings/tab.ts renders it and nothing else, so adding a setting means adding a row here rather
 * than editing a renderer.
 */
export const SETTING_BLOCKS: readonly SettingBlock[] = [
  {
    kind: "group",
    heading: "Content",
    settings: [
      {
        name: "Fetch live currency exchange rates",
        desc: "Download current exchange rates so currency conversions use up-to-date values. "
          + "When off, Numbat works fully offline.",
        control: { type: "toggle", key: "fetchExchangeRates" },
        // No `refreshInlayHints`/`refreshInlineEval` here, deliberately: effects run synchronously,
        // and the fetch they would need to follow is async. `ensureExchangeRates` repaints itself
        // once the rates have actually changed — which also covers a scheduled refetch hours into a
        // session, when no setting has changed at all and no effect could fire.
        effects: ["ensureExchangeRates", "invalidateCompletionVocabulary"],
      },
      {
        name: "Exchange rate refresh frequency (hours)",
        desc: "Cached exchange rates are reused for this many hours before being re-fetched. "
          + "Only applies when live rates are enabled.",
        visibleWhen: "fetchExchangeRates",
        control: { type: "number", key: "exchangeRateRefreshHours", min: 1 },
      },
      {
        name: "Exchange rate fetch timeout (seconds)",
        desc: "Give up fetching live rates after this many seconds and fall back to the last rates cached on disk "
          + "(kept in the plugin folder). Only applies when live rates are enabled.",
        visibleWhen: "fetchExchangeRates",
        control: { type: "number", key: "exchangeRateTimeoutSeconds", min: 1 },
      },
      {
        name: "Custom prelude",
        desc: "Load your own Numbat (.nbt) files into every interpreter context — code blocks and the REPL "
          + "alike — as a personal prelude of custom units, constants, and functions.",
        control: { type: "toggle", key: "customPrelude" },
        effects: ["markPreludeDirty"],
      },
    ],
  },
  // Sits inside the Content section, directly under its Custom prelude toggle: a list cannot nest
  // inside a declarative `group`, whose items are plain settings, so it is a top-level block placed
  // between the two groups.
  { kind: "prelude-list", visibleWhen: "customPrelude" },
  {
    kind: "group",
    heading: "Completions",
    settings: [
      {
        name: "Unicode expansion",
        desc: "Expand LaTeX-style codes such as \\alpha to α as you type, inside numbat and numbat-shared code "
          + "blocks and the REPL input. When a code matches, it replaces the text; otherwise the keystroke is "
          + "left untouched so other plugins can handle it.",
        control: { type: "toggle", key: "unicodeExpansion" },
      },
      {
        name: "Unicode leader",
        desc: "The character(s) that introduce a code, before its name — `\\` for `\\alpha`.",
        visibleWhen: "unicodeExpansion",
        control: { type: "text", key: "unicodeLeader", placeholder: "\\", validate: validateLeader },
      },
      {
        name: "History completion",
        desc: "In the REPL, type the history leader (e.g. `?:`) to open a completer of your previous inputs; keep "
          + "typing to filter, then pick one to fill the input. Arrow-key recall works independently.",
        control: { type: "toggle", key: "historyCompletion" },
      },
      {
        name: "History leader",
        desc: "The character(s) typed at the start of the REPL input to open the history completer.",
        visibleWhen: "historyCompletion",
        control: { type: "text", key: "historyLeader", placeholder: "?:", validate: validateLeader },
      },
      {
        name: "Expression completion",
        desc: "Autocomplete Numbat names as you type — two characters into a word, or straight after `.` or `:` — "
          + "in numbat and numbat-shared code blocks and the REPL. The unicode and history leaders take "
          + "precedence, so it never gets in the way of a `\\code` or a history query.",
        control: { type: "toggle", key: "exprCompletion" },
      },
      {
        name: "Complete identifiers",
        desc: "Variables, constants, and functions (such as `pi`, `c`, and `sin`).",
        visibleWhen: "exprCompletion",
        control: { type: "toggle", key: "completeIdentifiers" },
      },
      {
        name: "Complete keywords",
        desc: "Keywords and operators (such as `to`, `per`, `let`, `if`, and `where`).",
        visibleWhen: "exprCompletion",
        control: { type: "toggle", key: "completeKeywords" },
      },
      {
        name: "Complete units",
        desc: "Units (such as `meter`, `second`, and `newton`), including metric-prefixed forms like "
          + "`kilometer`.",
        visibleWhen: "exprCompletion",
        control: { type: "toggle", key: "completeUnits" },
      },
      {
        name: "Complete dimensions",
        desc: "Physical dimensions (such as `Length`, `Time`, and `Mass`).",
        visibleWhen: "exprCompletion",
        control: { type: "toggle", key: "completeDimensions" },
      },
      {
        name: "Complete types",
        desc: "Built-in and structural types (such as `Bool`, `String`, and structs).",
        visibleWhen: "exprCompletion",
        control: { type: "toggle", key: "completeTypes" },
      },
      {
        name: "Hover information",
        desc: "Point at a Numbat symbol — in a code block, an inline span, or a Numbat property's value — and see "
          + "the same documentation card the completer shows: what it is, its type, its value, and a link to "
          + "where you defined it. Never opens while a completer is on screen.",
        control: { type: "toggle", key: "hover" },
        effects: ["refreshHover"],
      },
      {
        name: "Hover with the mouse",
        desc: "Open the card when the pointer rests on a symbol.",
        visibleWhen: "hover",
        // No effect on purpose: the two trigger toggles are read live, since swapping the editor
        // extension is the risky part.
        control: { type: "toggle", key: "hoverMouse" },
      },
      {
        name: "Hover on cursor dwell",
        desc: "Also open the card when the *caret* rests on a symbol — moving to a symbol opens it, typing never "
          + "does. With Vim key bindings on, this applies in insert mode only; normal mode uses the key below.",
        visibleWhen: "hover",
        control: { type: "toggle", key: "hoverDwell" },
      },
      {
        name: "Hover delay (milliseconds)",
        desc: "How long the pointer or the caret must rest on a symbol before the card opens.",
        visibleWhen: "hover",
        control: { type: "number", key: "hoverDelayMs", min: 0 },
        // The delay is baked in when the extension is built, so it needs the rebuild. The
        // imperative path used to omit this, which made the setting inert on every public build.
        effects: ["refreshHover"],
      },
      {
        name: "Vim normal-mode key",
        desc: "The normal-mode key that opens the card at the cursor, in Vim notation (`H` by default; `K` matches "
          + "the convention used by code editors, and leaves Vim's own `H` motion alone). Leave blank to map "
          + "nothing — the **Show info at the cursor** command can be bound to any hotkey instead.",
        visibleWhen: "hover",
        control: { type: "text", key: "hoverVimKey", placeholder: "H" },
        effects: ["refreshHover"],
      },
    ],
  },
  {
    kind: "group",
    heading: "Editor",
    settings: [
      {
        name: "Inline results and type hints",
        desc: "In numbat and numbat-shared code blocks, show each line's result and the inferred types inline as you "
          + "edit — without switching to reading view. Hints are muted and dimmed, and color like the block.",
        control: { type: "toggle", key: "inlayHints" },
        effects: ["refreshInlayHints"],
      },
      {
        name: "Show line results",
        desc: "Show each expression's computed result at the end of its line, such as `= 7 m [Length]` — "
          + "or, when a statement fails to evaluate, its error's summary.",
        visibleWhen: "inlayHints",
        control: { type: "toggle", key: "inlayResults" },
        effects: ["refreshInlayHints"],
      },
      {
        name: "Show type hints",
        desc:
          "Show a binding's inferred type after its name (such as `let x: Length`) where you did not write one, and "
          + "the expected type of an incomplete expression as a placeholder (such as `3 m +` showing a `Length`) — "
          + "the latter in the REPL input as well.",
        visibleWhen: "inlayHints",
        control: { type: "toggle", key: "inlayTypes" },
        effects: ["refreshInlayHints"],
      },
      {
        name: "Tab indent width",
        desc: "How many spaces Tab inserts in a `.nbt` file, aligned to the next multiple of this width; Shift-Tab "
          + "steps back to the previous one, and a selection indents every line it spans. With the completion "
          + "popup open Tab still accepts the selected completion; to move focus out of the editor instead, press "
          + "`Esc` and then `Tab`.",
        control: { type: "number", key: "nbtIndentWidth", min: MIN_INDENT_WIDTH, max: MAX_INDENT_WIDTH },
        effects: ["refreshIndentWidth"],
      },
      {
        name: "Vim mode",
        desc: "Vim key bindings in the REPL input. \"Match Obsidian\" follows your editor's \"Vim key bindings\" "
          + "setting; or force it on or off. Basic Vim only — your vimrc mappings are not applied here (they "
          + "still apply in numbat code blocks).",
        control: {
          type: "dropdown",
          key: "replVimMode",
          options: { match: "Match Obsidian", on: "On", off: "Off" },
        },
        effects: ["refreshReplVim"],
      },
    ],
  },
  {
    kind: "group",
    heading: "Inline evaluation",
    settings: [
      {
        name: "Inline expression evaluation",
        desc: "Evaluate a Numbat expression written inline in prose. Type `` n`5 km + 3 mi` `` for a live result "
          + "shown after the span (click it to bake it into the note), or `` nc`5 km + 3 mi` `` to have the "
          + "value written straight into the text and kept up to date. Inline expressions can use values from "
          + "numbat-shared blocks and earlier inline expressions in the same note.",
        control: { type: "toggle", key: "inlineEval" },
        effects: ["refreshInlineEval"],
      },
      {
        name: "Reading-view display",
        desc: "How a rendered inline evaluation appears in reading view: just the value, or the expression and value "
          + "together. Applies on the next reading-view render.",
        visibleWhen: "inlineEval",
        control: {
          type: "dropdown",
          key: "inlineEvalReadingStyle",
          options: { value: "Value only", expression: "Expression = value" },
        },
      },
      {
        name: "Keep expression on commit",
        desc: "When committing a live inline result to text (by clicking it or via the command), write "
          + "`expression = value` rather than replacing it with the value alone.",
        visibleWhen: "inlineEval",
        control: { type: "toggle", key: "inlineEvalRetainExpr" },
      },
      {
        name: "Live prefix",
        desc: "The letters before a code span that mark a live inline evaluation (default `n`).",
        visibleWhen: "inlineEval",
        control: { type: "text", key: "inlineEvalLivePrefix", placeholder: "n", validate: validatePrefix },
        effects: ["refreshInlineEval"],
      },
      {
        name: "Concrete prefix",
        desc:
          "The letters before a code span that mark a concrete (auto-materialized) inline evaluation (default `nc`).",
        visibleWhen: "inlineEval",
        control: { type: "text", key: "inlineEvalConcretePrefix", placeholder: "nc", validate: validatePrefix },
        effects: ["refreshInlineEval"],
      },
      {
        name: "Default decimal places",
        desc: "Display inline results with this many decimal places — truncating or zero-padding as needed, via "
          + "Numbat's own formatting. Leave blank for full precision. A span can override it with a leading "
          + "config: `` n`{dp=3} 5 + 25/60` `` forces three places, and `` n`{dp=} …` `` returns that span to "
          + "full precision.",
        visibleWhen: "inlineEval",
        control: { type: "text", key: "inlineEvalDecimalPlaces", validate: validateDecimalPlaces },
        effects: ["refreshInlineEval"],
      },
      {
        name: "Evaluate in frontmatter",
        desc: "Also evaluate inline expressions written in a note's YAML frontmatter (properties). Results show "
          + "while editing in Source mode, not in the rendered properties panel.",
        visibleWhen: "inlineEval",
        control: { type: "toggle", key: "inlineEvalFrontmatter" },
        effects: ["refreshInlineEval"],
      },
      {
        name: "Evaluate in code blocks",
        desc: "Also evaluate inline expressions written inside fenced code blocks of other languages (not `numbat` "
          + "blocks, which evaluate themselves). Results show while editing in Source mode, not in the rendered block.",
        visibleWhen: "inlineEval",
        control: { type: "toggle", key: "inlineEvalCodeBlocks" },
        effects: ["refreshInlineEval"],
      },
    ],
  },
  {
    kind: "group",
    heading: "Note properties",
    settings: [
      {
        name: "Note properties feed Numbat",
        desc: "A property assigned the Numbat property type (from the property's type menu) binds its value as an "
          + "expression, replayed before every code block, inline expression, and completion in the note — in "
          + "frontmatter order, so a later property can use an earlier one. A property whose name is already a "
          + "Numbat unit, function, variable, or dimension is skipped with an error rather than shadowing it.",
        control: { type: "toggle", key: "noteProperties" },
        effects: ["refreshNoteScope"],
      },
      {
        name: "Number properties bind as scalars",
        desc: "Properties without the Numbat type whose value is a plain number also join the note's scope, as "
          + "dimensionless scalars.",
        visibleWhen: "noteProperties",
        control: { type: "toggle", key: "notePropertyNumbers" },
        effects: ["refreshNoteScope"],
      },
      {
        name: "Text properties bind as strings",
        desc: "Properties without the Numbat type whose value is text also join the note's scope, as Numbat "
          + "strings — so `str_length`, `str_append` and string interpolation apply to them. This is the widest "
          + "of these four: most frontmatter is prose, so most of a note's properties become Numbat names.",
        visibleWhen: "noteProperties",
        control: { type: "toggle", key: "notePropertyText" },
        effects: ["refreshNoteScope"],
      },
      {
        name: "Date properties bind as datetimes",
        desc: "Properties assigned Obsidian's Date or Datetime type, or this plugin's Zoned Date and Zoned Datetime "
          + "types, also join the note's scope, as Numbat `DateTime`s, so date arithmetic "
          + "(`due - today() -> days`) works on them. The type has to be assigned — Obsidian shows its date picker "
          + "without assigning one, and a date-shaped value that is not a date should not become a moment. A value "
          + "naming a zone (`2026-07-27 [Europe/Berlin]`) is read at the offset that zone had on that date; one "
          + "carrying only a UTC offset is read exactly as written; one with neither is read in the zone below, and "
          + "a date with no time of day is that zone's midnight.",
        visibleWhen: "noteProperties",
        control: { type: "toggle", key: "notePropertyDates" },
        effects: ["refreshNoteScope"],
      },
      {
        name: "Time zone for dates",
        desc: "The zone a date, or a time written without a UTC offset, is read in — an IANA name such as "
          + "`Europe/Berlin`, or a literal offset such as `+02:00`. Leave blank for your own zone. A named zone "
          + "follows daylight saving, so a date in January and one in July are each read at the offset that zone "
          + "actually had.",
        visibleWhen: "notePropertyDates",
        control: {
          type: "text",
          key: "notePropertyDefaultZone",
          placeholder: "Local",
          validate: validateTimeZone,
        },
        effects: ["refreshNoteScope"],
      },
      {
        name: "Checkbox properties bind as booleans",
        desc: "Properties whose value is a checkbox or a toggle also join the note's scope, as Numbat booleans, "
          + "for use with `if … then … else`. A checkbox that has never been ticked binds as `false`.",
        visibleWhen: "noteProperties",
        control: { type: "toggle", key: "notePropertyBooleans" },
        effects: ["refreshNoteScope"],
      },
      {
        name: "Import other notes with `numbat-use`",
        desc: "A `numbat-use` frontmatter property naming other notes (as `[[links]]`) imports their `numbat-shared` "
          + "blocks and Numbat-typed properties into this note's scope — replayed before the note's own properties. "
          + "Follows links transitively, with a cycle guard.",
        visibleWhen: "noteProperties",
        control: { type: "toggle", key: "noteImports" },
        effects: ["refreshNoteScope"],
      },
    ],
  },
  {
    kind: "group",
    heading: "Appearance",
    settings: [
      {
        name: "Live REPL highlighting",
        desc: "Syntax-highlight the REPL input expression as you type, matching the colors used in numbat code "
          + "blocks. When off, the input is shown as plain text.",
        control: { type: "toggle", key: "liveReplHighlight" },
        effects: ["refreshReplHighlight"],
      },
      {
        name: "Custom font size",
        desc: "Override the font sizes used by the REPL. When off, the REPL follows the theme's code size.",
        control: { type: "toggle", key: "customReplFont" },
        effects: ["refreshReplFont"],
      },
      {
        name: "REPL view font size",
        desc: FONT_DESC,
        visibleWhen: "customReplFont",
        control: {
          type: "text",
          key: "replViewFontSize",
          placeholder: DEFAULT_REPL_FONT_SIZE,
          validate: validateFontSize,
        },
        effects: ["refreshReplFont"],
      },
      {
        name: "REPL input font size",
        desc: FONT_DESC,
        visibleWhen: "customReplFont",
        control: {
          type: "text",
          key: "replInputFontSize",
          placeholder: DEFAULT_REPL_FONT_SIZE,
          validate: validateFontSize,
        },
        effects: ["refreshReplFont"],
      },
      {
        name: "REPL history entries",
        desc: "Maximum number of previous REPL inputs kept for arrow-key recall and history completion.",
        control: { type: "number", key: "replHistoryLimit", min: 1 },
      },
      {
        name: "REPL visible lines",
        desc: "Maximum number of lines kept visible in the REPL log. Older lines scroll off and are removed "
          + "from view; the interpreter session itself is unaffected.",
        control: { type: "number", key: "replMaxLines", min: 1 },
      },
    ],
  },
  {
    kind: "group",
    heading: "Runtime",
    settings: [
      {
        name: "Free the interpreter when idle (seconds)",
        desc: "Release the cached completion interpreters after this many seconds without a completion, reclaiming "
          + "the memory they hold (a large code block replays into one). They rebuild on next use, taking a "
          + "moment. Set to 0 to keep them loaded.",
        control: { type: "number", key: "completionIdleSeconds", min: 0 },
      },
    ],
  },
  { kind: "version-card" },
];

// STRINGS FOR THE NON-DESCRIPTOR BLOCKS
// ================================================================================================
//
// The prelude list and the version card are rendered imperatively (they are not uniform rows), so
// their user-visible text cannot live in a descriptor. It lives here anyway, beside the rest of the
// tab's copy, so the settings text is all in one file and the tab tests can assert on it.

/** Heading above the prelude file list. */
export const PRELUDE_LIST_HEADING = "Prelude files";

/** Explains the list's ordering and that paths follow renames. */
export const PRELUDE_LIST_DESC =
  "Loaded in order, on top of Numbat's standard prelude, so later files can build on earlier ones. "
  + "Changes to the files are picked up automatically, and their paths follow moves and renames.";

/** Shown in place of the list when no prelude files are configured. */
export const PRELUDE_EMPTY = "No prelude files yet — add one to get started.";

/** Label of the button that appends a new prelude row. */
export const ADD_PRELUDE_NAME = "Add prelude file";

/** Placeholder for a prelude row's display-name field, which may be left blank. */
export const PRELUDE_NAME_PLACEHOLDER = "Name (optional)";

/** Placeholder for a prelude row's vault-path field. */
export const PRELUDE_PATH_PLACEHOLDER = "prelude.nbt";

/** Label of the version card's button, which copies the versions to the clipboard for pasting into
 *  a bug report. */
export const COPY_DEBUG_INFO = "Copy debug info";

// DERIVED VIEWS OVER THE TABLE
// ================================================================================================

/** Every descriptor, flattened out of its group. */
export function allDescriptors(): SettingDescriptor[] {
  return SETTING_BLOCKS.flatMap((block) => (block.kind === "group" ? [...block.settings] : []));
}

/** Each setting's effects, by the key it is stored under. Built once — Obsidian calls
 *  `setControlValue` on every keystroke in a text field. */
export const EFFECTS_BY_KEY: ReadonlyMap<string, readonly SettingEffect[]> = new Map(
  allDescriptors()
    .filter((descriptor) => descriptor.effects !== undefined)
    .map((descriptor) => [descriptor.control.key as string, descriptor.effects ?? []]),
);

/** The minimum each number setting declares, derived from the table so a control cannot be added
 *  without one. */
export const NUMBER_MINIMUMS: ReadonlyMap<NumberSettingKey, number> = new Map(
  allDescriptors()
    .map((descriptor) => descriptor.control)
    .filter((control) => control.type === "number")
    .map((control) => [control.key, control.min] as const),
);

/** The maximum each number setting declares, where it declares one — sparse, because most have no
 *  natural ceiling (see `SettingControl`). */
export const NUMBER_MAXIMUMS: ReadonlyMap<NumberSettingKey, number> = new Map(
  allDescriptors().flatMap(({ control }) =>
    control.type === "number" && control.max !== undefined
      ? [[control.key, control.max] as [NumberSettingKey, number]]
      : []
  ),
);

/** Whether a stored value is one of the options its dropdown offers. */
function isDropdownOption(control: SettingControl, value: unknown): boolean {
  return control.type === "dropdown" && typeof value === "string"
    && Object.keys(control.options).includes(value);
}

/**
 * Build a usable settings object from persisted data, discarding anything a consumer could not
 * handle. Applied on load *and* after every write, so `plugin.settings` is the one place the
 * invariants are known to hold.
 *
 * This is enforcement, not presentation — Obsidian's `validate` only shows a message (see the
 * Validators section above). Without it, values that a control merely *declares* out of range still
 * reach the code:
 *
 *   * `exchangeRateTimeoutSeconds: 0` makes the fetch wait forever — the exact inverse of the
 *     setting, since a non-positive timeout means "no timeout";
 *   * `exchangeRateRefreshHours: 0` requests rates on every interpreter use;
 *   * `replHistoryLimit: 0` drains the history on every submit, killing recall;
 *   * `replMaxLines: 0` trims the log to one entry after every append;
 *   * `nbtIndentWidth: 0` makes CodeMirror's `indentUnit` throw while the `.nbt` editor is being
 *     constructed, so the file does not open at all — the one setting with a ceiling too, since the
 *     width becomes that many spaces on every indented line.
 *
 * Out-of-range is not the only way in. A key merely *present* in `data.json` beats the default even
 * when its value is `null` — and `JSON.stringify(NaN)` is `null`, so a number field the user clears
 * could persist as one and defeat its own default across every later restart. Hence the type check,
 * not just the clamp.
 *
 * `preludeFiles` is excluded: it has a shape of its own, normalized by `normalizePreludeFiles`.
 */
export function normalizeSettings(loaded: Record<string, unknown> | null): SymbatSettings {
  const settings: SymbatSettings = { ...DEFAULT_SETTINGS };
  const target = settings as unknown as Record<string, unknown>;
  const controls = new Map(
    allDescriptors().map((descriptor) => [descriptor.control.key as string, descriptor.control]),
  );

  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (key === "preludeFiles") {
      continue;
    }
    const value = loaded?.[key];

    // `typeof null` is "object", so null is rejected by the type check itself.
    if (value === undefined || typeof value !== typeof fallback) {
      continue;
    }
    const control = controls.get(key);

    // A dropdown's stored value must still be one it offers, and a text setting's must still pass
    // its own validator — a rename or a hand-edited data.json can leave either holding something
    // the consumer cannot read.
    if (control?.type === "dropdown" && !isDropdownOption(control, value)) {
      continue;
    }
    if (control?.type === "text" && typeof value === "string" && control.validate?.(value) !== undefined) {
      continue;
    }

    target[key] = value;
  }

  for (const [key, min] of NUMBER_MINIMUMS) {
    const value = settings[key];
    const max = NUMBER_MAXIMUMS.get(key) ?? Number.POSITIVE_INFINITY;
    target[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_SETTINGS[key];
  }

  return settings;
}
