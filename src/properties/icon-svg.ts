// The markup behind this plugin's own copies of Obsidian's icons.
//
// A property type tells Obsidian which icon to draw by *name*, and Obsidian draws it — so there is
// no element of ours to put a class on, and no way to say "this type is not one of yours" in the
// type menu. What there *is* is `addIcon`, which registers an icon of our own under an id of our
// own. So each of our types uses a copy of the Lucide glyph it would have used anyway, wrapped in a
// `<g>` carrying a class of this plugin's — which styles.css can then tint.
//
// The tint is the type menu's alone, and that one scoping is the one place styles.css names a class
// of Obsidian's (`menu`): these icons are drawn by Obsidian, into DOM this plugin never sees, so
// unlike a widget of ours — which knows which surface it is on, decided in properties/host.ts —
// there is nothing here to tell the menu from the property row except what the icon sits inside.
//
// Two coordinate systems meet here, which is the only subtle part. Lucide draws in a 24-unit box;
// `addIcon` wraps what it is given in a `viewBox="0 0 100 100"`. See {@link ICON_SCALE}.
//
// This module is the string-building half, so it imports nothing and can be tested;
// properties/registry.ts reads the source icon out of Obsidian and registers the result.

/** The class our icon copies carry, and the one thing styles.css keys off to tint them. */
export const ICON_TINT_CLASS = "numbat-type-icon";

/**
 * Lucide's box into `addIcon`'s box.
 *
 * A `transform="scale(100/24)"` makes the wrapped group's user space *exactly* the 24-unit space
 * the source icon was drawn in — so its path data needs no rewriting, and neither does its
 * `stroke-width`. Stroke widths are lengths in the element's own user space, so the `2` Lucide
 * writes renders as 2/24 of the icon's box either way: identical to the built-in glyph beside it.
 * Dividing it by this scale — the obvious-looking move — draws hairlines.
 */
export const ICON_SCALE = 100 / 24;

/**
 * The attributes that carry the drawing and live on the source `<svg>` root: copying an icon's
 * markup alone leaves them behind, and their initial values are not benign. `fill` defaults to
 * black, so a glyph that has lost `fill="none"` is a silhouette; `stroke` defaults to `none`, so
 * one that has lost `stroke="currentColor"` is invisible.
 *
 * They are *presentation* attributes, which any author stylesheet rule outranks — so carrying them
 * over costs the tint nothing.
 */
export const CARRIED_ATTRS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
] as const;

/**
 * A source icon's markup as content for `addIcon`: scaled into the 100-unit box, given back the
 * root attributes it was drawn with, and marked with {@link ICON_TINT_CLASS}.
 *
 * `attrs` is what the source root carried — absent ones (`null`, or simply missing) are omitted
 * rather than guessed at, so an icon drawn some other way keeps whatever its own markup says.
 */
export function tintedIconContent(inner: string, attrs: Readonly<Record<string, string | null>>): string {
  const carried = CARRIED_ATTRS
    .map((name) => {
      const value = attrs[name];
      return value === null || value === undefined ? "" : ` ${name}="${escapeAttribute(value)}"`;
    })
    .join("");

  return `<g class="${ICON_TINT_CLASS}" transform="scale(${ICON_SCALE.toFixed(6)})"${carried}>${inner}</g>`;
}

/** Attribute-value escaping. The values come from Obsidian's own icons, so this is belt and
 *  braces — but they are read at runtime from an undocumented source and pasted into markup. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
