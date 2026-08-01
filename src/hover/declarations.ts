// Names the *source* declares but the interpreter cannot be asked about: a function's parameters, a
// struct's fields, a declaration's type parameters.
//
// `print_info` and `type()` answer for things that exist in a context — bindings, units,
// dimensions. A parameter exists only inside its function's body, a field only inside its struct's
// type, so hovering either asks the interpreter about a name it has never heard of. But the answer
// is right there in the text: the declaration that introduced it, a few lines up at most. This
// module reads it back out.
//
// Pure (no Obsidian, CodeMirror, or wasm imports), like completion/expressions.ts, whose
// `typeVariablesInScopeAt` does the same job for type parameters and is reused here.

import { declarationStillOpen, typeVariablesInScopeAt } from "../completion/expressions";

/** What a declaration says about one of the names it introduces. */
export interface DeclaredSymbol {
  /** What the declaration introduces it as — shown verbatim as the card's label. */
  kind: "parameter" | "field" | "type parameter";

  /** The name as written in the declaration. */
  name: string;

  /** The declared type, as written (`List<D>`, `Money`, `Dim`), or `null` when the declaration
   *  gives none. */
  type: string | null;

  /** The `fn` / `struct` that declares it, when it has a name. */
  owner: string | null;
}

/** A declaration opener, with the keyword and the declared name. */
const DECLARATION = /^\s*(fn|struct)\s+([\p{L}_][\p{L}\p{N}_]*)/u;

/** How far back a declaration's header can reasonably sit from the line using one of its names — a
 *  long multi-line signature and body, but not the whole note. */
const MAX_LOOKBACK = 60;

/**
 * What `name`, used on 0-indexed `line` of `lines`, is declared as — or `null` when no enclosing
 * `fn`/`struct` declares it.
 *
 * The enclosing declaration is the nearest `fn`/`struct` at or above the line whose body has not
 * closed before it. Only the declaration's *header* is searched (its parameter list, or a struct's
 * field list), so a local name that merely appears in a body is not mistaken for a parameter.
 */
export function declaredSymbolAt(
  lines: readonly string[],
  line: number,
  name: string,
): DeclaredSymbol | null {
  const opener = enclosingDeclaration(lines, line);
  if (opener === null) {
    return null;
  }

  const { keyword, owner, startLine } = opener;
  const header = lines.slice(startLine, line + 1).join("\n");

  // Type parameters first: `<D: Dim>` binds before the value parameters that use it.
  for (const parameter of typeVariablesInScopeAt(header)) {
    if (parameter.name === name) {
      return { kind: "type parameter", name, type: parameter.dimBound ? "Dim" : null, owner };
    }
  }

  const declaredType = annotatedType(header, name);
  if (declaredType === undefined) {
    return null;
  }

  return { kind: keyword === "struct" ? "field" : "parameter", name, type: declaredType, owner };
}

/** The nearest `fn`/`struct` declaration at or above `line` that still encloses it, or `null`.
 *  "Still encloses" is judged by bracket balance, which is what tells a declaration's body from the
 *  code after it. */
function enclosingDeclaration(
  lines: readonly string[],
  line: number,
): { keyword: string; owner: string; startLine: number; } | null {
  const first = Math.max(0, line - MAX_LOOKBACK);
  for (let n = line; n >= first; n -= 1) {
    const match = DECLARATION.exec(lines[n] ?? "");
    if (match === null) {
      continue;
    }

    // Whether the declaration still covers this line is the same question the completer asks of its
    // type parameters, and it is not simple bracket balance — a `fn … =` body continues onto the
    // next line with everything closed. One rule for both (declarationStillOpen), so the two cannot
    // disagree about where a declaration ends.
    if (n === line || declarationStillOpen(lines.slice(n, line + 1).join("\n"))) {
      return { keyword: match[1], owner: match[2], startLine: n };
    }

    return null; // the nearest declaration closed above this line
  }
  return null;
}

/**
 * The type annotated on `name` in a declaration header — `x: Scalar` → `Scalar` — or `null` when
 * the name is declared with no type, or `undefined` when the header does not declare it at all. The
 * type runs to the next `,`, closing bracket, or line end, whichever comes first, so a generic type
 * (`List<D>`) survives intact.
 */
function annotatedType(header: string, name: string): string | null | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const annotated = new RegExp(`[(,{]\\s*${escaped}\\s*:\\s*([^,)}\\n]+)`, "u").exec(header);
  if (annotated !== null) {
    return annotated[1].trim();
  }

  // Declared, but with no type of its own (an inferred parameter).
  const bare = new RegExp(`[(,{]\\s*${escaped}\\s*[,)}]`, "u").exec(header);
  return bare === null ? undefined : null;
}
