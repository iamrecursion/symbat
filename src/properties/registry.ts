// The two *global* registries this plugin writes to for the sake of how its property types
// present: the widget record's key order, which is the order Obsidian's type menu lists types in,
// and the icon library, which is where their green non-native icons come from.
//
// Both are cosmetic, both are undocumented, and both are written through the same defensive shape
// the type registrations themselves use (properties/type.ts, properties/date-type.ts): a missing
// registry costs the polish and nothing else. The decisions live in the two modules that import
// nothing — properties/type-order.ts and properties/icon-svg.ts — leaving this one as lookups, a
// subscription and a disposer.

import { addIcon, getIcon } from "obsidian";
import type SymbatPlugin from "../main";
import { CARRIED_ATTRS, tintedIconContent } from "./icon-svg";
import { propertyTypeManager, type PropertyWidget } from "./note";
import { applyKeyOrder, plannedOrder, restoredOrder } from "./type-order";

// THE TYPE MENU'S ORDER
// ================================================================================================

/**
 * Keep the property-type registry sorted by display name, for as long as the plugin is loaded.
 *
 * Called after the plugin's own types are registered, so the first pass already places them. It
 * runs again whenever the manager announces a change, which is how a type registered later — by
 * another plugin, or by a Bases view asking for one — is sorted in rather than left at the end.
 *
 * The order the registry was found in is restored on unload, the same way every other write in
 * `properties/` is reverted.
 */
export function installTypeOrder(plugin: SymbatPlugin): void {
  const manager = propertyTypeManager(plugin.app);
  const widgets = manager?.registeredTypeWidgets;
  if (manager === null || widgets === undefined) {
    return; // properties/type.ts has already said so; a second complaint about the polish is noise
  }

  const pristine = Object.keys(widgets);

  // The order this last wrote. The check against it is what keeps the `changed` subscription cheap:
  // that event fires on every type *assignment* too, and re-sorting is only work when the set of
  // registered types has actually moved.
  let written: string | null = null;

  const apply = () => {
    const keys = Object.keys(widgets);
    if (keys.join("\0") === written) {
      return;
    }

    const order = plannedOrder(keys, (key) => displayName(widgets[key], key));
    applyKeyOrder(widgets, order);
    written = order.join("\0");

    // Deliberately *not* followed by `manager.trigger("changed")`. Nothing about the types or their
    // assignments has changed — only the order the menu will be built in, and it is built when it
    // is opened. Announcing it is also how two plugins that both sort on `changed` would hand the
    // event back and forth forever.
  };

  apply();

  const events = manager.on?.("changed", apply);
  if (events !== undefined && events !== null) {
    plugin.registerEvent(events);
  }

  plugin.register(() => {
    applyKeyOrder(widgets, restoredOrder(Object.keys(widgets), pristine));
  });
}

/** The name a registry entry shows under, or its id when it will not say — including when a
 *  foreign widget's `name()` throws, which is a reason to leave the menu alone rather than to fail
 *  a plugin load. */
function displayName(widget: unknown, key: string): string {
  try {
    return (widget as PropertyWidget | undefined)?.name?.() ?? key;
  } catch {
    return key;
  }
}

// THE NON-NATIVE ICONS
// ================================================================================================

/** Icon ids this plugin has registered, by the Lucide name they were copied from — or that name
 *  itself, where the copy could not be made. Memoized because `addIcon` is a global write and the
 *  answer cannot change within a session. */
const tinted = new Map<string, string>();

/**
 * The icon id a property type should use: this plugin's own copy of `lucide`, which styles.css
 * tints green to mark the type as one Obsidian did not come with — or `lucide` itself, untinted,
 * on an Obsidian that will not hand its icons over.
 *
 * The copy is made from what Obsidian actually draws, rather than from icon markup vendored here,
 * so the glyph tracks whatever Lucide version the app ships.
 *
 * `addIcon` has no counterpart, so the ids registered here outlive the plugin's unload — three of
 * them, until the app restarts. With styles.css gone they simply draw in the colour every other
 * icon does, which is why this is left as it is rather than worked around.
 */
export function tintedIcon(lucide: string): string {
  const known = tinted.get(lucide);
  if (known !== undefined) {
    return known;
  }

  const id = registerTinted(lucide);
  tinted.set(lucide, id);
  return id;
}

/** Register one copy, or answer with the name that was asked for. */
function registerTinted(lucide: string): string {
  try {
    const source = getIcon(lucide);
    // Reading `innerHTML` is a get, so the markup Obsidian drew is being copied rather than
    // anything being injected; `addIcon` is the sanctioned way back in.
    const inner = source?.innerHTML ?? "";
    if (inner === "") {
      return lucide; // an Obsidian that renamed the glyph, or one that draws it some other way
    }

    const attrs = Object.fromEntries(CARRIED_ATTRS.map((name) => [name, source?.getAttribute(name) ?? null]));
    const id = `numbat-${lucide}`;
    addIcon(id, tintedIconContent(inner, attrs));
    return id;
  } catch (error) {
    console.error(`Symbat: could not register a tinted copy of the ${lucide} icon`, error);
    return lucide;
  }
}
