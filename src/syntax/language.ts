// A CodeMirror 6 language mode for Numbat, used by the sidebar REPL input.
//
// Unlike `numbat` fences embedded in a Markdown document — where Numbat is one language among many
// and syntax/highlight.ts must locate the fences itself — the REPL input is *wholly* Numbat, so it
// can carry a real CM6 language. Numbat's lexer is context-free and line-oriented (comments and
// strings never span lines), so a `StreamLanguage` wrapping the shared line tokenizer
// (syntax/tokenizer.ts's `classify`) is a faithful, single-source port — no second lexer to drift.
//
// The language provides token semantics (a completer and future features build on it); the *color*
// for the REPL input comes from the same decoration-based highlighter the editor's code blocks use
// (see syntax/highlight.ts's `numbatReplHighlight`), so the REPL follows the identical static +
// dynamic discipline — capitalization heuristic first, then the interpreter's real
// type/dimension/unit names as they are learned — rather than a separate `HighlightStyle` that
// would drift from it.

import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { classify, type LexState, newLexState } from "./tokenizer";
import { semanticKind } from "./type-names";

/**
 * The stream parser: each token is read by the shared lexer. `classify` advances the stream by at
 * least one character for any non-blank input (see its progress guarantee in syntax/tokenizer.ts),
 * satisfying CM6's requirement that a token read makes progress. The lexer carries per-line state
 * (a pending `dimension`/`unit` declaration and the dimension-expression position), which CM6
 * supplies and copies across token reads; `semanticKind` colors known type/dimension/unit names.
 */
const numbatStreamParser: StreamParser<LexState> = {
  name: "numbat",
  startState: () => newLexState(),
  copyState: (state) => ({ ...state, dimVars: new Set(state.dimVars) }),
  token: (stream, state) => classify(stream, semanticKind, state),
};

/** The Numbat language: tokenizer only — a single-line REPL expression needs no parse tree,
 *  indentation, or folding. Color comes from a decoration highlighter (syntax/highlight.ts), not
 *  this language, so the REPL matches the code blocks exactly. */
export const numbatLanguage = StreamLanguage.define(numbatStreamParser);
