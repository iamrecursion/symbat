// Whether a context that has already been used can be used again.
//
// A Numbat context is consumed by use. The wasm surface is `new`/`interpret`/`free`, so a context
// accumulates whatever is evaluated into it and the only way back to a known state is to build
// another one.
//
// That build is the largest cost in the plugin: `Numbat.new(true, …)` loads the whole standard
// library, measured at 55 ms in the build environment and ~163 ms in Obsidian, against 2.6 ms for a
// replay and 0.0 ms for a context with no standard library at all. Nothing else in a build is at
// all significant beside it.
//
// Reuse is thus worth a great deal, and it turns on two questions about text, asked from opposite
// ends. What the last user left behind: {@link definesNames}. What the next user could notice:
// {@link readsLastAnswer}. A context may pass from one to the other only when the first answers no
// and the second answers no.
//
// **Both err towards refusing**, and that is what makes them safe to write lexically. A wrong
// `true` costs one standard-library load, which is exactly what every caller pays today. A wrong
// `false` hands somebody a context carrying a definition from an unrelated note: a valid-looking
// answer with nothing wrong on its face The two directions are not comparable, and these lean hard
// on the cheap one.
//
// Imports only syntax/identifier.ts, which imports nothing, so this loads under plain
// `node --test`.

import { WORD_CHAR } from "../syntax/identifier";

// A statement that puts a name into the environment.
//
// Numbat's five declaration forms plus `use`, which pulls a module's worth of them in.
const DEFINITION = /^\s*(?:let|unit|fn|dimension|struct|use)\b/;

// A decorator, which only ever precedes a declaration, on the line below it (`@metric_prefixes`)
// or on the same one (`@aliases(m) unit metre = …`). Either way the text defines a name.
//
// **Matched by its `@` alone, and not by where its argument ends.** A decorator argument is a
// Numbat string, so it may contain a `)` — `@url("https://en.wikipedia.org/wiki/Mercury_(planet)")`
// is an ordinary line of the standard library. A pattern that looked for the closing parenthesis
// stopped at the one inside the string, read `unit mercury = …` after it as ordinary text, and
// answered `false`: the single direction this file may not take. Nothing else in Numbat begins a
// line with `@`, so there is no precision left to buy by parsing further.
const DECORATOR = /^\s*@/;

/**
 * Whether evaluating this text could leave anything behind in the context it is evaluated in.
 *
 * The question a reused context has to ask about the reader it is being handed *from*. Evaluating
 * an expression leaves the environment as it found it, so an expression may be evaluated in a
 * context that is already positioned at its scope, which saves a standard-library load per
 * keystroke on the property path (properties/note-outcomes.ts) and one per code block on the
 * evaluating paths. A _declaration_ is not pure: one evaluated into a shared context is visible to
 * every later reader of it, and would collide with itself on the next keystroke.
 *
 * Deliberately conservative and textual: the shapes it can misjudge are ones that get a fresh
 * context, which is what they would have had anyway. It errs towards `true`: a keyword inside a
 * string or a comment is read as a declaration rather than looked through, since blanking those to
 * be sure would cost more than the context it saves.
 */
export function definesNames(text: string): boolean {
  return text.split("\n").some((line) => DEFINITION.test(line) || DECORATOR.test(line));
}

/**
 * The two names Numbat binds to the value of the statement before.
 *
 * Pinned against the interpreter rather than inferred from its behaviour: `name_resolution.rs`'s
 * `LAST_RESULT_IDENTIFIERS` is `["ans", "_"]`, and `typechecker/mod.rs:1396` binds both from
 * `Statement::Expression` and from no other statement kind. So a context that evaluated only
 * expressions differs from a fresh one in exactly these two bindings, and a context that evaluated
 * nothing which type-checked differs in none.
 */
export const LAST_RESULT_NAMES: readonly string[] = ["ans", "_"];

const LAST_RESULT = new Set(LAST_RESULT_NAMES);

/** Runs of identifier characters, built from the shared character class (syntax/identifier.ts) so
 *  the two cannot drift. Matching whole words this way rather than with a lookbehind keeps the
 *  expression portable, which matters on the WebKit that Obsidian mobile runs. */
const WORDS = new RegExp(`${WORD_CHAR.source}+`, "gu");

/**
 * Whether evaluating this text could notice what the context evaluated last.
 *
 * The same question as {@link definesNames} asked from the other end, because a context that ran
 * only expressions is *not* quite pristine. It carries {@link LAST_RESULT_NAMES}, where a fresh
 * context carries neither, so `ans` at the top of a code block is an error today and would silently
 * become the previous block's value under a reused one.
 *
 * Whole-word rather than substring: `_` is an identifier character, so Numbat's digit separator
 * makes `5_000_000` a single word, and `_poisson` is a name in the prelude. Neither is the bare
 * `_` this is looking for.
 *
 * Not stripped of comments and strings, unlike interpreter/purity.ts's scan, and for the opposite
 * reason: that predicate must not miss an occurrence, so it pays to find where the code really is,
 * while this one is free to answer `true` about the word `ans` in a comment and hand out a fresh
 * context to a block that would have been fine with a used one.
 */
export function readsLastAnswer(text: string): boolean {
  // `matchAll` compiles its own pattern copy, so the shared `WORDS` never carries a `lastIndex`
  // between calls, which an `exec` loop over the same constant would.
  for (const [word] of text.matchAll(WORDS)) {
    if (LAST_RESULT.has(word)) {
      return true;
    }
  }

  return false;
}
