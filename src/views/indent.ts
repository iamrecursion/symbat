// Tab indents in the `.nbt` file editor, rather than moving focus out of it.
//
// CodeMirror ships `indentWithTab` (Tab -> indentMore, Shift-Tab -> indentLess), but neither half
// behaves the way an indent key should here:
//
//   * `indentMore` inserts the unit at the *start of every line a range touches* — including an
//     empty caret sitting mid-line, which then indents the line rather than the cursor. That is
//     right for a block indent and wrong for typing, so the caret case is handled here and aligned
//     to the next tab stop: Tab at column 3 with a width of 2 inserts one space and lands on 4. A
//     real selection still goes to `indentMore`, which is exactly what it is for.
//   * `indentLess` *subtracts* a unit from the column rather than rounding down to the previous
//     stop, so a line indented by three spaces dedents to one rather than to two. {@link
//     removeIndent} rounds down instead, so Tab and Shift-Tab agree on where the stops are and a
//     misaligned line is pulled back onto the grid rather than kept off it.
//
// Everything here is a `StateCommand` or a pure helper, so it is testable against an `EditorState`
// alone — views/input.ts, which installs the keymap, drags in Obsidian and the wasm interpreter and
// cannot be imported from a test.

import { indentMore } from "@codemirror/commands";
import { getIndentUnit, indentString, indentUnit } from "@codemirror/language";
import { type ChangeSpec, countColumn, EditorSelection, type Extension, type StateCommand } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/** The narrowest indent the editor accepts. A hard floor, not a preference: `indentUnit`'s facet
 *  combiner *throws* on an empty string, and it does so inside `EditorState.create` — so a width of
 *  zero would take the whole `.nbt` view down on open rather than degrade to something usable. */
export const MIN_INDENT_WIDTH = 1;

/** The widest indent the editor accepts. The width becomes `" ".repeat(width)` on every indented
 *  line, so an unbounded one is a way to make the editor unusable (or hang) from a settings field.
 */
export const MAX_INDENT_WIDTH = 8;

/** The indent width a `.nbt` editor uses when the setting has not been read (and the setting's own
 *  default). Two spaces: Numbat's own examples and prelude are written that way. */
export const DEFAULT_INDENT_WIDTH = 2;

/**
 * The `indentUnit` string for a configured width. Total by construction — a non-finite or
 * out-of-range width is clamped rather than trusted, because the failure mode is a throw that
 * prevents the editor opening at all (see {@link MIN_INDENT_WIDTH}).
 */
export function indentUnitFor(width: number): string {
  // NaN survives both comparisons in a `Math.min`/`Math.max` clamp, so it is excluded first.
  const clamped = Number.isNaN(width)
    ? MIN_INDENT_WIDTH
    : Math.min(MAX_INDENT_WIDTH, Math.max(MIN_INDENT_WIDTH, Math.trunc(width)));
  return " ".repeat(clamped);
}

/** The `indentUnit` facet for a width, as the compartment the setting reconfigures carries it. */
export function numbatIndentUnit(width: number): Extension {
  return indentUnit.of(indentUnitFor(width));
}

/**
 * Tab: a selection indents every line it spans ({@link indentMore}); a bare caret inserts enough
 * spaces to reach the next tab stop, at the caret rather than at the start of the line.
 */
export const insertIndent: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) {
    return false;
  }

  // Any non-empty range makes this a block indent, which is exactly what `indentMore` does.
  if (state.selection.ranges.some((range) => !range.empty)) {
    return indentMore({ state, dispatch });
  }

  // In columns, which is what the tab-stop arithmetic needs.
  const unit = getIndentUnit(state);
  dispatch(state.update(
    state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      const column = countColumn(state.doc.sliceString(line.from, range.head), state.tabSize);
      const insert = " ".repeat(unit - (column % unit));
      return {
        changes: { from: range.head, insert },
        range: EditorSelection.cursor(range.head + insert.length),
      };
    }),
    { scrollIntoView: true, userEvent: "input.indent" },
  ));
  return true;
};

/**
 * Shift-Tab: pull every line the selection touches back to the previous tab stop — from column 3
 * with a width of 2 that is column 2, not column 1 as `indentLess` would give. A line with no
 * indentation is left alone, but the key is still consumed, so Shift-Tab never surprises by moving
 * focus backwards out of the editor when Tab does not move it forwards.
 */
export const removeIndent: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) {
    return false;
  }

  const unit = getIndentUnit(state);
  const changes: ChangeSpec[] = [];
  const done = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let pos = range.from;;) {
      const line = state.doc.lineAt(pos);
      if (!done.has(line.from)) {
        done.add(line.from); // ranges (and a multi-line one's own lines) can revisit a line
        const space = /^\s*/.exec(line.text)?.[0] ?? "";
        const column = countColumn(space, state.tabSize);
        if (column > 0) {
          // A column on a stop steps back a whole unit; one off the grid rounds down onto it.
          const insert = indentString(state, column - (column % unit === 0 ? unit : column % unit));

          // Rewrite only the tail that actually differs, so an untouched prefix keeps its position
          // mapping (and the undo history stays as small as CodeMirror's own dedent makes it).
          let keep = 0;
          while (keep < space.length && keep < insert.length && space[keep] === insert[keep]) {
            keep++;
          }
          changes.push({ from: line.from + keep, to: line.from + space.length, insert: insert.slice(keep) });
        }
      }
      if (line.to >= range.to) {
        break;
      }
      pos = line.to + 1;
    }
  }

  if (changes.length > 0) {
    dispatch(state.update({ changes, userEvent: "delete.dedent" }));
  }
  return true;
};

/**
 * Tab/Shift-Tab for a document. Installed *below* the completion keymap, so an open completer still
 * owns Tab (accepting its selection) and these only ever see the key with the popup closed.
 *
 * Nothing here binds Escape: CodeMirror's own tab-focus mode already arms on an unhandled Escape
 * and lets the next Tab through to the browser, so Esc-then-Tab (or Ctrl-M) still moves focus out
 * of the editor for keyboard navigation.
 */
export const numbatIndentKeymap: Extension = keymap.of([
  { key: "Tab", run: insertIndent, shift: removeIndent },
]);
