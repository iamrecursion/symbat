// Which scopes can produce a different answer from the same text.
//
// Every evaluation cache in the plugin is keyed by content and by `interpreterGeneration()`, on the
// assumption that the same input in the same interpreter yields the same answer. For two Numbat
// builtins that is false: `now()` and `random()`. By tracking purity we can stop aging scopes that
// are not impure as their results will never change.
//
// The impure surface is small and enumerable. Exactly two FFI functions read something outside the
// program: `now()` (numbat/src/ffi/datetime.rs, `Zoned::now()`) and `random()`
// (numbat/src/ffi/math.rs, `rand::random::<f64>()`). Everything else clock- or randomness-shaped in
// the bundled prelude is defined in terms of those two, so the roots close over a fixed list — see
// {@link IMPURE_NAMES}, which is pinned against NUMBAT_TAG and re-checked by
// test/integration/interpreter/purity.test.ts.
//
// Two near-misses, recorded so they are not re-litigated. `exchange_rate` reads a process-global
// set once per wasm instance, and a rate change already bumps `interpreterGeneration()`, which
// every key folds in. `get_local_timezone()` returns a zone name rather than an instant and is
// stable for the life of a session; the `local` conversion function depends on the instant it is
// *given*, which is an argument.
//
// Imports only syntax/identifier.ts, which imports nothing, plus one erased `import type`, so this
// loads under plain `node --test`.

import type { NotePreamble } from "../properties/parse";
import { WORD_CHAR } from "../syntax/identifier";

/**
 * Every prelude name that reaches `now()` or `random()`, transitively: the closure computed over
 * the pinned `numbat/modules` sources rather than read off the documentation.
 *
 * The clock family is small because it funnels through one private helper: `_today_str()` is
 * `format_datetime("%Y-%m-%d", now())`, and `today()` and `time(s)` are both `datetime(…)` of it.
 * The random family is the ten `rand_*` distributions in `math/distributions.nbt`, plus the private
 * `_poisson` recursion that `rand_poisson` is written on top of.
 *
 * Notably _not_ here: the `human` duration family. Its members read `time` all over their bodies,
 * but as the name of their own parameter, a `Time` value handed in, which shadows the prelude
 * function of that name. That is the one place where the whole-word test below is measurably wrong
 * about Numbat's own source, and it is wrong in the safe direction.
 */
export const IMPURE_NAMES: readonly string[] = [
  // Reads the clock.
  "now",
  "_today_str",
  "today",
  "time",

  // Reads the RNG.
  "random",
  "rand_uniform",
  "rand_int",
  "rand_bernoulli",
  "rand_binom",
  "rand_norm",
  "rand_geom",
  "rand_poisson",
  "rand_expon",
  "rand_lognorm",
  "rand_pareto",
  "_poisson",
];

const IMPURE = new Set(IMPURE_NAMES);

/**
 * Runs of identifier characters, built from the shared character class (syntax/identifier.ts) so
 * the two cannot drift. Matching whole words this way rather than with a lookbehind keeps the
 * expression portable.
 */
const WORDS = new RegExp(`${WORD_CHAR.source}+`, "gu");

/**
 * The parts of `text` Numbat would actually execute with comment bodies and string-literal text
 * removed, string *interpolations* kept.
 *
 * Stripping is not cosmetic, and neither half of it is optional. Skipping comments is what keeps
 * the predicate useful: `now`, `today` and `time` are three of the commonest words in English, so a
 * note whose block carries `# time to destination` would otherwise be evaluated as though it read
 * the clock. The notes most likely to write that sentence are exactly the ones doing date
 * arithmetic, so the false positives would concentrate on this feature's own audience. Numbat's
 * own prelude demonstrates it: `fibonacci` and `lucas` are flagged by an unstripped scan, on their
 * comment "use Binet's formula for constant time".
 *
 * Skipping string *text* extends the same argument to `@description("…")` and `@example("…")`
 * decorators, which a user prelude may carry and which are prose by construction.
 *
 * Keeping interpolations is what keeps it *sound*: `"{now()}"` is perfectly valid, and the
 * prelude's own `today()` is written that way. So is the string-awareness of the comment rule — `#`
 * inside a string literal is not a comment, and Numbat's prelude has URL fragments
 * (`…f64.html#method.abs`) to prove it. A scanner that split on `#` would swallow the rest of the
 * line, which is a false *negative* and the one direction this must never fail in.
 */
function executableText(text: string): string {
  let out = "";

  // One entry per code region currently open: the top-level, plus one for each string interpolation
  // nested inside it. The number counts struct braces opened within that region, so the `}` of
  // `Foo { a: 1 }` is not mistaken for the end of an interpolation.
  const braces: number[] = [0];
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\") {
        i += 1; // the escaped character is text whatever it is
      } else if ((ch === "{" || ch === "}") && text[i + 1] === ch) {
        i += 1; // `{{` and `}}` are escaped braces, not an interpolation
      } else if (ch === "{") {
        inString = false;
        braces.push(0);
        out += " ";
      } else if (ch === "\"" || ch === "}") {
        // A closing quote ends the literal; a lone `}` is unbalanced, and Numbat's tokenizer ends
        // the literal there too rather than carrying on.
        inString = false;
        out += " ";
      }
      continue;
    }

    if (ch === "#") {
      // A comment runs to the end of the line. The newline itself is kept, so the words either side
      // of it stay separate.
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      out += "\n";
    } else if (ch === "\"") {
      inString = true;
      out += " ";
    } else if (ch === "{") {
      braces[braces.length - 1] += 1;
      out += ch;
    } else if (ch === "}") {
      if (braces[braces.length - 1] > 0) {
        braces[braces.length - 1] -= 1;
        out += ch;
      } else if (braces.length > 1) {
        braces.pop();
        inString = true; // back into the literal the interpolation was written inside
        out += " ";
      } else {
        out += ch; // unbalanced; nothing to close
      }
    } else {
      out += ch;
    }
  }

  return out;
}

/**
 * Whether evaluating this text could give a different answer next time.
 *
 * The test is lexical and conservative: the text is impure if any name in {@link IMPURE_NAMES}
 * appears in it as a whole word, in a position Numbat would execute. A false positive costs one
 * re-evaluation, which is what *every* scope costs today; a false negative would show a frozen
 * clock, so the two directions are not comparable and this leans hard on the cheap one.
 *
 * There is no false-negative path through the language. Numbat has no `eval`, so a call site always
 * writes its callee's name, and a higher-order use (`map(now, …)`) writes it too. What it does not
 * see is a *rename*: a scope that does `let n = now` and then calls `n()` still writes `now` at the
 * binding, so the scope as a whole is caught (which is why callers pass whole scopes rather than
 * single expressions).
 *
 * Not memoized. It is a single linear pass, but callers reach for it on a cache lookup rather than
 * on an evaluation, so it belongs behind the same key the cache is already using.
 */
export function readsClockOrRandom(text: string): boolean {
  if (text === "") {
    return false;
  }

  // `matchAll` compiles its own copy of the pattern, so the shared `WORDS` never carries a
  // `lastIndex` between calls — which an `exec` loop over the same constant would.
  for (const [word] of executableText(text).matchAll(WORDS)) {
    if (IMPURE.has(word)) {
      return true;
    }
  }

  return false;
}

/**
 * Which of a note's bindings can produce a different answer next time, in binding order: the flag
 * each cached outcome is filed with (properties/outcome-cache.ts), which is what decides whether it
 * ever ages out.
 *
 * **Monotone by construction, not by assertion.** A binding's scope is the prelude, the imports,
 * and every binding above it, so once something impure has been seen every binding below it is
 * impure too — the loop below latches rather than re-deciding. That is also what lets the note
 * batch resume partway down instead of restarting: the first `true` is the first binding that can
 * have moved, and everything above it is answered for good. A note with thirty properties and one
 * `now()` in the last re-evaluates one property per freshness window rather than thirty; a note
 * with none is never re-evaluated on a timer at all, which is the whole of what this is for.
 *
 * `preludeIsImpure` covers what is replayed *ahead* of the preamble — the user prelude files. It
 * is an argument rather than something read here because a preamble does not carry it, and a
 * caller that left it out would get a silently wrong all-pure answer for every note in a vault
 * whose prelude defines `fn t() = now()`: the note writes no impure token, but its scope holds
 * one.
 *
 * A *decided* boolean rather than the prelude's text, because the prelude changes far less often
 * than notes are evaluated — once per reload against once per pass — and the caller holding the
 * text is the one that decides it (interpreter/numbat.ts's `preludeReadsClockOrRandom`). Passing
 * text here would invite a whole-prelude scan per note. The scope inspector's *partial* prelude
 * is covered by the same boolean: it is a prefix of the whole, so a pure prelude has pure
 * prefixes and an impure one is answered conservatively.
 */
export function impureBindings(preamble: NotePreamble, preludeIsImpure = false): boolean[] {
  // `expr` and `defs` alongside `code` out of conservatism rather than necessity: a nested
  // property's `code` is the rebuilt `let` of its whole object and already carries every field's
  // expression, but the three are cheap and the union cannot be the direction that fails.
  let impure = preludeIsImpure || (preamble.imports ?? []).some((chunk) => readsClockOrRandom(chunk));

  const flags: boolean[] = [];
  for (const binding of preamble.bindings) {
    impure = impure
      || readsClockOrRandom(binding.code)
      || readsClockOrRandom(binding.expr)
      || binding.defs.some((def) => readsClockOrRandom(def));
    flags.push(impure);
  }

  return flags;
}
