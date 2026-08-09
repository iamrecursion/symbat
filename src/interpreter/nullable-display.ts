// Reading a nullable value back out of Numbat's formatter output.
//
// The interpreter knows nothing about what `Opt` means (see interpreter/nullable.ts): it prints the
// struct it was handed, so an undefined property reads as `Opt { value: [] }` and a defined one as
// `Opt { value: [70] }`. What the reader wants to see is `nil` and `70`. This module rewrites the
// one into the other, everywhere the plugin shows Numbat output.
//
// Only *values* are rewritten. The type is left exactly as Numbat prints it — `Opt<Scalar>`,
// `List<Opt<Scalar>>` — because it is a type the reader can write, and a display that differs from
// what the parser accepts is a worse deal than a slightly longer name.
//
// It works on the formatter's *spans* rather than on the text, because a value is only ever
// delimited by them: Numbat emits every `{`, `[` and `<` as an operator span of its own, and the
// contents of a string as a string span — so brace matching over operator spans cannot be fooled by
// a brace written inside a string, and needs no escaping rules of its own. Pure, so it is
// unit-testable without Obsidian or the wasm bindings.

import { NULLABLE_STRUCT } from "./nullable";

/** One piece of formatter output: a `<span>` (with its class and escaped text) or the raw text
 *  between two of them, which is only ever layout whitespace. */
interface Token {
  /** The span's class, or `null` for raw text. */
  cls: string | null;

  /** The span's text, still HTML-escaped, or the raw text itself. */
  text: string;

  /** The token exactly as it was written, so anything kept survives byte for byte. */
  html: string;
}

/** Numbat's formatter emits flat, single-class spans — the same assumption interpreter/render.ts's
 *  span refinement already makes. */
const SPAN = /<span class="([^"]*)">([^<]*)<\/span>/g;

/** Split formatter output into spans and the raw text between them. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;

  SPAN.lastIndex = 0;
  for (let match = SPAN.exec(html); match !== null; match = SPAN.exec(html)) {
    if (match.index > last) {
      const text = html.slice(last, match.index);
      tokens.push({ cls: null, text, html: text });
    }
    tokens.push({ cls: match[1], text: match[2], html: match[0] });
    last = match.index + match[0].length;
  }

  if (last < html.length) {
    const text = html.slice(last);
    tokens.push({ cls: null, text, html: text });
  }

  return tokens;
}

/** Whether the token is the given operator — the class Numbat gives every delimiter. */
function isOperator(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.cls === "numbat-operator" && token.text === text;
}

/** Whether the token is layout rather than content. */
function isBlank(token: Token): boolean {
  return token.cls === null && token.text.trim() === "";
}

/** The index of the next token that is not layout, or the length when there is none. */
function nextContent(tokens: readonly Token[], from: number): number {
  let index = from;
  while (index < tokens.length && isBlank(tokens[index])) {
    index += 1;
  }
  return index;
}

/**
 * The index of the operator closing the one at `open`, or `-1` when it is never closed. Counts
 * nesting, so the `]` found for a `[` is that bracket's own.
 */
function matching(tokens: readonly Token[], open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (isOperator(tokens[index], opener)) {
      depth += 1;
    } else if (isOperator(tokens[index], closer)) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** A span of the plugin's own making, for the one word this module has to write itself. */
function span(cls: string, text: string): Token {
  return { cls, text, html: `<span class="${cls}">${text}</span>` };
}

/**
 * How an absent value reads: `nil`, the name the prelude binds it under, so what is shown is what
 * can be written. Faint, because it is the absence of data rather than data.
 *
 * Its class is deliberately *not* `numbat-dimmed`, which is the class Numbat dims a type annotation
 * with and so the obvious one to borrow. That class is load-bearing elsewhere: `resultValueHtml`
 * (evaluation/inlay-parse.ts) cuts a result at the first `numbat-dimmed` span to drop the trailing
 * `[Dimension]` annotation, so a `nil` wearing it ends the value early — `[70, nil]` reads back as
 * `[70,`, and the inline-eval widget commits that truncation into the note. The two are given the
 * same colour in `styles.css`. The class name says *undefined* rather than *nil* because it names
 * the thing — a property with no value — rather than the word currently chosen for it.
 */
const NIL: Token = span("numbat-undefined", "nil");

/** Whether the token is the nullable struct's own name — which Numbat spans as a type identifier
 *  wherever it stands, in front of a value as much as in a type. */
function isNullable(token: Token): boolean {
  return token.cls === "numbat-type-identifier" && token.text === NULLABLE_STRUCT;
}

/**
 * Rewrite every nullable value in a token run, innermost first: `Opt { value: [x] }` becomes `x`,
 * keeping the inner value's own spans and so its colouring, and an empty list becomes `nil`.
 *
 * The name in any other position — a type, or a bare mention in a diagnostic — is left alone,
 * because `Opt` is what the reader would write there themselves.
 */
function rewrite(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!isNullable(token)) {
      out.push(token);
      index += 1;
      continue;
    }

    const value = rewriteValue(tokens, index, nextContent(tokens, index + 1), out);
    if (value !== -1) {
      index = value;
      continue;
    }

    out.push(token);
    index += 1;
  }

  return out;
}

/** Rewrite `Opt { value: [x] }` at `open` into `out`, returning where to resume, or `-1` when this
 *  is not a value. */
function rewriteValue(tokens: readonly Token[], open: number, after: number, out: Token[]): number {
  if (!isOperator(tokens[after], "{")) {
    return -1;
  }

  const close = matching(tokens, after, "{", "}");
  if (close === -1) {
    return -1;
  }

  // The struct has one field, so the first bracket inside it opens that field's list.
  const list = tokens.findIndex((token, at) => at > after && at < close && isOperator(token, "["));
  const listEnd = list === -1 ? -1 : matching(tokens, list, "[", "]");
  if (list === -1 || listEnd === -1 || listEnd > close) {
    return -1;
  }

  const held = tokens.slice(list + 1, listEnd);
  out.push(...held.every(isBlank) ? [NIL] : rewrite(held));
  return close + 1;
}

// THE SAME NAME IN A DIAGNOSTIC
// ================================================================================================
//
// Everything above works on spans. A diagnostic does not: Numbat renders an error message as prose
// inside a single `numbat-diagnostic-…` span, and leaves the type argument's angle brackets
// unescaped in it — so `SPAN`, whose text group stops at a `<`, does not match that span at all.
// There are no delimiters left to match on, which is why the shape below is matched in text.

/** How a diagnostic opens the struct, and how it opens the struct body that has to follow — the
 *  single field the encoding has, printed with the same type argument in it. */
const DUMP_OPEN = `${NULLABLE_STRUCT}<`;
const DUMP_BODY_OPEN = " {value: List<";

/**
 * The angle brackets of the type this pass writes back out, escaped.
 *
 * Numbat leaves them raw, and raw is not survivable: everything here goes through Obsidian's
 * `sanitizeHTMLToDom` (interpreter/render.ts), which parses `<Scalar>` as an element rather than
 * showing it, so `got Opt<Scalar> instead` would reach the reader as `got Opt instead`. The old
 * `Scalar?` form had no brackets to lose, which is the only reason this never had to be handled.
 *
 * Only `<` and `>` are touched, and only where a rewrite emits them: an `&` is left alone so that
 * an already-escaped bracket — one the recursion below has just written — is not escaped twice.
 * The rest of the diagnostic keeps whatever Numbat gave it, brackets included; a message naming
 * some *other* generic type loses it the same way it always has.
 */
function escapeAngles(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The index of the `>` closing a `<` already stepped over, or `-1` when it is never closed. Counts
 *  nesting, so the one found for `List<Scalar>` is that type's own. */
function closingAngle(text: string, from: number): number {
  let depth = 1;
  for (let at = from; at < text.length; at += 1) {
    if (text[at] === "<") {
      depth += 1;
    } else if (text[at] === ">") {
      depth -= 1;
      if (depth === 0) {
        return at;
      }
    }
  }
  return -1;
}

/**
 * Drop the struct body an error message dumps: `Opt<X> {value: List<X>}` becomes `Opt&lt;X&gt;`, so
 * reading a hole without handling it reports `Expected dimension type, got Opt<Scalar> instead` —
 * the type as the reader would write it, rather than that type followed by a restatement of how it
 * is built, which is the one thing the message does not need to say. See {@link escapeAngles} for
 * why what is written back is escaped where what was read was not.
 *
 * Worth doing because this feature *creates* the error. Before an empty property bound at all, the
 * same mistake said "unknown identifier", which was clear; now it binds, and this is the message
 * standing in for that one.
 *
 * What makes a text match safe here is the shape: the argument is written twice, once as the type
 * parameter and once inside the struct body, and only an exact repeat is rewritten. So prose that
 * merely mentions the name keeps it — including the prelude's own source line, which an arity error
 * quotes, where `Opt<T>` is a definition being shown rather than a type being reported. A string
 * written to imitate a type error verbatim would be rewritten inside, which is the one guarantee
 * given up by leaving the spans behind, and costs a cosmetic edit to a string that was already
 * claiming to be something it is not.
 */
function readableDiagnosticNullables(text: string): string {
  let out = "";
  let at = 0;

  for (let open = text.indexOf(DUMP_OPEN, at); open !== -1; open = text.indexOf(DUMP_OPEN, at)) {
    const argStart = open + DUMP_OPEN.length;
    const argEnd = closingAngle(text, argStart);
    const arg = argEnd === -1 ? "" : text.slice(argStart, argEnd);
    const body = `${DUMP_BODY_OPEN}${arg}>}`;

    // Not the dump shape: keep the name as written and carry on past it.
    if (argEnd === -1 || !text.startsWith(body, argEnd + 1)) {
      out += text.slice(at, argStart);
      at = argStart;
      continue;
    }

    // The argument can hold a dump of its own, so it is rewritten before it is written out.
    out += text.slice(at, open) + NULLABLE_STRUCT + "&lt;"
      + escapeAngles(readableDiagnosticNullables(arg)) + "&gt;";
    at = argEnd + 1 + body.length;
  }

  return out + text.slice(at);
}

/**
 * Rewrite the nullable values in one piece of formatter output, and tidy the struct dump a
 * diagnostic prints.
 *
 * Applied to everything the reader sees (see interpreter/numbat.ts's `readableOutput`), and cheap
 * on the overwhelming majority of output, which holds no nullable at all — though `Opt` is short
 * enough that the guard below lets prose that merely contains those three letters through. What
 * keeps that safe is that neither pass matches on the name alone: the span pass needs a
 * type-identifier span holding exactly it, and the text pass needs the whole dump shape.
 */
export function readableNullables(html: string): string {
  if (!html.includes(NULLABLE_STRUCT)) {
    return html;
  }

  const spans = rewrite(tokenize(html)).map((token) => token.html).join("");

  // The span pass has taken every nullable that was written as one. What can still be left is a
  // diagnostic, whose angle brackets are *unescaped* — so an unescaped `<` right after the name is
  // both what the text pass looks for and the sign that there is one to find.
  return spans.includes(DUMP_OPEN) ? readableDiagnosticNullables(spans) : spans;
}
