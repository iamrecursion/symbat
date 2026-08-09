// Names the *source* declares but the interpreter cannot be asked about: a function's parameters
// and its `where`/`and` locals, a struct's fields, a declaration's type parameters.
//
// `print_info` and `type()` answer for things that exist in a context — bindings, units,
// dimensions. A parameter exists only inside its function's body, a field only inside its struct's
// type, so hovering either asks the interpreter about a name it has never heard of. But the answer
// is right there in the text: the declaration that introduced it, a few lines up at most. This
// module reads it back out.
//
// The reading itself is the completer's (completion/expressions.ts, whose `enclosingDeclarationAt`,
// `declaredNamesIn` and `typeParametersOf` answer the same three questions for the completion
// popover) — so a name the completer offers inside a declaration is one the hover can describe, and
// the two cannot disagree about how far the declaration reaches.

import {
  type DeclaredName,
  declaredNamesIn,
  enclosingDeclarationAt,
  typeParametersOf,
} from "../completion/expressions";

/** What a declaration says about one of the names it introduces. */
export interface DeclaredSymbol {
  /** What the declaration introduces it as — shown verbatim as the card's label. */
  kind: DeclaredName["kind"] | "type parameter";

  /** The name as written in the declaration. */
  name: string;

  /** The declared type, as written (`List<D>`, `Money`, `Dim`), or `null` when the declaration
   *  gives none. */
  type: string | null;

  /** The `fn` / `struct` that declares it. */
  owner: string;
}

/**
 * What `name`, used on 0-indexed `line` of `lines`, is declared as — or `null` when no enclosing
 * `fn`/`struct` declares it.
 *
 * The enclosing declaration is the nearest `fn`/`struct` at or above the line whose body has not
 * closed before it. Only the names that declaration *introduces* are answered for — its parameter
 * list, its `where`/`and` bindings, or a struct's field list — so an ordinary local use is not
 * mistaken for one of them.
 */
export function declaredSymbolAt(
  lines: readonly string[],
  line: number,
  name: string,
): DeclaredSymbol | null {
  const before = lines.slice(0, line + 1).join("\n");
  const declaration = enclosingDeclarationAt(before);
  if (declaration === null) {
    return null;
  }

  const { owner } = declaration;

  // Type parameters first: `<D: Dim>` binds before the value parameters that use it. Asked of the
  // declaration already in hand, rather than scanning for it a second time.
  for (const parameter of typeParametersOf(declaration)) {
    if (parameter.name === name) {
      return { kind: "type parameter", name, type: parameter.dimBound ? "Dim" : null, owner };
    }
  }

  const declared = declaredNamesIn(declaration).find((entry) => entry.name === name);
  return declared === undefined ? null : { kind: declared.kind, name, type: declared.type, owner };
}
