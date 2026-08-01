// Pure helpers for the settings tab. No imports, so they are unit-testable without Obsidian.

/** A user prelude entry: a display name and the vault path of its `.nbt` file. */
export interface PreludeFile {
  /** The label shown in the settings list and the scope inspector. */
  name: string;

  /** Vault path of the `.nbt` file. */
  path: string;
}

/** One run of a settings description: plain prose, or an inline code span (the text that was
 *  written between backticks, which the tab renders as `<code>`). */
export interface DescSegment {
  /** The segment's text, backticks stripped. */
  text: string;

  /** Whether to render it as a `<code>` span rather than prose. */
  code: boolean;
}

/**
 * Split a description string into prose and backtick-delimited code segments, so the settings tab
 * can render the code parts as monospaced `<code>` rather than showing literal backticks. Follows
 * CommonMark's code-span rule: an opening run of N backticks closes at the next run of exactly N,
 * so a double-backtick span can show literal backticks inside it — `` `` n`5 km + 3 mi` `` ``
 * renders as ``n`5 km + 3 mi` `` — and one space is trimmed from each end of the content when both
 * are present (which is how such a span is written readably). A run with no matching closer is
 * ordinary text; an empty span is omitted.
 */
export function parseCodeSpans(markup: string): DescSegment[] {
  const segments: DescSegment[] = [];

  let i = 0;
  while (i < markup.length) {
    const open = markup.indexOf("`", i);
    if (open === -1) {
      segments.push({ text: markup.slice(i), code: false });
      break;
    }

    // Measure the opening backtick run, then find the next run of exactly the same length — a run
    // of a different length is content, not the closer.
    let runLen = 1;
    while (markup[open + runLen] === "`") {
      runLen += 1;
    }

    let scan = open + runLen;
    let close = -1;
    while (scan < markup.length) {
      const at = markup.indexOf("`", scan);
      if (at === -1) {
        break;
      }

      let len = 1;
      while (markup[at + len] === "`") {
        len += 1;
      }

      if (len === runLen) {
        close = at;
        break;
      }

      scan = at + len;
    }

    if (close === -1) {
      // No matching closer — the remainder (backticks included) is literal prose.
      segments.push({ text: markup.slice(i), code: false });
      break;
    }

    if (open > i) {
      segments.push({ text: markup.slice(i, open), code: false });
    }

    let text = markup.slice(open + runLen, close);
    if (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") {
      text = text.slice(1, -1);
    }

    if (text !== "") {
      segments.push({ text, code: true });
    }

    i = close + runLen;
  }

  return segments;
}

/**
 * Coerce persisted data into a well-formed `PreludeFile[]`. Accepts the current shape (an array of
 * `{ name, path }`) and migrates the previous shape (a plain array of path strings, `legacyPaths`)
 * when no current value is present. Anything else yields an empty list.
 */
export function normalizePreludeFiles(current: unknown, legacyPaths?: unknown): PreludeFile[] {
  if (Array.isArray(current)) {
    return current
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({
        name: typeof entry.name === "string" ? entry.name : "",
        path: typeof entry.path === "string" ? entry.path : "",
      }));
  }

  if (Array.isArray(legacyPaths)) {
    return legacyPaths
      .filter((path): path is string => typeof path === "string")
      .map((path) => ({ name: "", path }));
  }

  return [];
}

/** One prelude file as it was actually loaded: its vault path and its contents. (The settings-side
 *  {@link PreludeFile} is the *configuration*; this is the result of reading it.) */
export interface PreludePart {
  /** Vault path it was read from — how `preludeSourceBefore` identifies a file. */
  path: string;

  /** The file's contents. */
  source: string;
}

/**
 * The prelude source to apply to an interpreter context, or `null` when there is none to apply.
 *
 * `before` names a prelude file to stop at, and yields only the files loaded ahead of it — which is
 * exactly what that file itself sees when the prelude is built. The `.nbt` editor asks for this so
 * that evaluating a prelude file's contents does not define everything in it a second time; a
 * repeated `unit` or `dimension` is an error, which would turn every result below the first into a
 * diagnostic.
 *
 * A `before` that names no prelude file (the ordinary case, and every caller but that editor) stops
 * nowhere, so every part applies.
 */
export function preludeSourceBefore(parts: readonly PreludePart[], before?: string): string | null {
  const index = before === undefined ? -1 : parts.findIndex((part) => part.path === before);
  const applied = index === -1 ? parts : parts.slice(0, index);
  return applied.length > 0 ? applied.map((part) => part.source).join("\n\n") : null;
}

/**
 * Return a copy of `list` with the item at index `from` moved to index `to`. `to` is clamped to the
 * valid range; an out-of-range `from` yields an unchanged copy. Used for reordering the prelude
 * file list.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) {
    return out;
  }

  const target = Math.max(0, Math.min(to, out.length - 1));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

/**
 * Whether `value` is a CSS length the REPL font-size settings accept: a `var(--custom-property)`
 * reference (with an optional fallback) or a non-negative number with a length unit. Used to avoid
 * writing an invalid custom property, which would break `font-size` outright rather than fall back
 * to the theme's code size.
 */
export function isValidCssFontSize(value: string): boolean {
  const v = value.trim();
  if (/^var\(--[A-Za-z0-9-]+(\s*,\s*[^()]+)?\)$/.test(v)) {
    return true;
  }

  return /^\d+(\.\d+)?(px|em|rem|%|pt|vh|vw)$/.test(v);
}
