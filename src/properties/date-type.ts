// The `Zoned Date` and `Zoned Datetime` property types: a date, or a moment, that can name a time
// zone. Obsidian's own Date type holds `YYYY-MM-DD` and nothing else, and its Datetime type
// discards any offset written by hand as soon as the widget writes — so a note that means "the
// 27th, in Berlin" has nowhere to say so, and properties/parse.ts then has to assume a zone for it.
// These types' values carry an optional `±HH:MM` suffix (`2026-07-27 +02:00`) or an RFC 9557 zone
// name, which is enough to say it.
//
// They are types of our own rather than patches on Obsidian's, and that is the design decision
// worth knowing: neither a suffixed date nor a bracketed zone name is a YAML timestamp or valid ISO
// 8601, so under Obsidian's types they would be broken dates to Bases, to sorting, to other
// plugins, and to Obsidian itself with this plugin disabled. Under our own ids nothing expects them
// to be native dates, so there is no contract to break — **and no monkey-patching anywhere**.
// Obsidian's own date types are left completely alone.
//
// An earlier version did patch the built-in Datetime widget, behind a setting, to add the same zone
// field to it. It was removed: replacing a core widget is brittle in a way owning a type is not —
// it inherits every change Obsidian makes to that widget, has to be undone exactly on unload, and
// has to coexist with whatever else has wrapped the same registry entry. `Zoned Datetime` covers
// the same ground, and a value under it still reads as a moment if it is later retyped.
//
// The calendar half is Obsidian's own date or datetime widget, delegated to rather than
// reimplemented, so its picker, its mobile behavior and its theming stay Obsidian's business. The
// zone field beside it and the write-through are properties/zone-editor.ts; every offset
// calculation is properties/zone.ts.

import type SymbatPlugin from "../main";
import { type PropertyTypeManager, propertyTypeManager, type PropertyWidget } from "./note";
import { ZONED_DATE_TYPE, ZONED_DATETIME_TYPE } from "./parse";
import { tintedIcon } from "./registry";
import { parseZoned, type ZonedValue } from "./zone";
import { buildZoneEditor } from "./zone-editor";

/**
 * Register the `Zoned Date` type. Same mechanism as the Numbat expression type
 * (properties/type.ts): a direct write into the undocumented widget registry, announced with
 * `trigger("changed")` and reverted on unload. On an Obsidian without the registry the type quietly
 * does not exist, and a property already assigned it falls back to the text widget.
 *
 * Registration is unconditional and needs no setting to gate it: adding an entry to the type menu
 * takes nothing away from anyone, which is exactly what replacing one of Obsidian's own widgets
 * would have done.
 */
export function registerZonedDateTypes(plugin: SymbatPlugin): void {
  const manager = propertyTypeManager(plugin.app);
  const widgets = manager?.registeredTypeWidgets;
  if (manager === null || widgets === undefined) {
    console.error("Symbat: this Obsidian exposes no property-type registry; the Zoned Date types are unavailable");
    return;
  }

  // A date, optionally zoned — and deliberately *not* a datetime. A value with a time of day cannot
  // be shown in the date picker it delegates to, so accepting one would mean dropping its time on
  // the first edit. Turning it away instead leaves the value under Obsidian's fallback widget,
  // intact and visibly the wrong type, which is the honest outcome. The datetime type is the mirror
  // image: anything a moment can be written as is fair game there.
  register(plugin, manager, widgets, {
    type: ZONED_DATE_TYPE,
    label: "Zoned Date",
    icon: "calendar",
    withTime: false,
    accepts: (parsed) => parsed.time === null,
    builtin: "date",
  });

  register(plugin, manager, widgets, {
    type: ZONED_DATETIME_TYPE,
    label: "Zoned Datetime",
    icon: "calendar-clock",
    withTime: true,
    accepts: () => true,
    builtin: "datetime",
  });
}

/** What separates the two types. Everything else about them is identical. */
interface ZonedTypeSpec {
  /** The registry id, and a compatibility contract once shipped. */
  type: string;

  /** Display name in the type menu. */
  label: string;

  /** Lucide icon name. */
  icon: string;

  /** Whether values carry a time of day — what the editor feeds the built-in `<input>`. */
  withTime: boolean;

  /** Whether a parsed value belongs to this type. */
  accepts: (parsed: ZonedValue) => boolean;

  /** The registry id of the built-in widget to borrow for the calendar half. */
  builtin: string;
}

/** Register one of the two types. */
function register(
  plugin: SymbatPlugin,
  manager: PropertyTypeManager,
  widgets: Record<string, unknown>,
  spec: ZonedTypeSpec,
): void {
  const widget = {
    type: spec.type,
    // The spec names the Lucide glyph; what goes into the registry is this plugin's own copy of it,
    // tinted green to mark the type as one Obsidian did not come with (properties/registry.ts).
    icon: tintedIcon(spec.icon),
    name: () => spec.label,
    validate: (value: unknown) => {
      if (value === null || value === undefined || value === "") {
        return true; // an empty property is every type's business
      }
      const parsed = parseZoned(value);
      return parsed !== null && spec.accepts(parsed);
    },
    render: (el, value, ctx) =>
      buildZoneEditor(plugin.app, el, value, ctx, {
        cls: spec.withTime ? "numbat-zoned-datetime" : "numbat-zoned-date",
        withTime: spec.withTime,
        draw: (plain, wrapped) => drawBuiltin(widgets, spec, el, plain, wrapped),
      }),
  } satisfies PropertyWidget;

  widgets[spec.type] = widget;
  manager.trigger?.("changed");
  plugin.register(() => {
    // Removed only if the entry is still the one registered here — the same rule properties/type.ts
    // applies, and for the same reason: another plugin may have wrapped this type since, and
    // deleting the key would take *their* widget away rather than ours. Leaving it costs nothing;
    // their wrapper delegates to an object nothing else references.
    if (widgets[spec.type] !== widget) {
      return;
    }

    delete widgets[spec.type];
    manager.trigger?.("changed");
  });
}

/**
 * Draw Obsidian's own date or datetime editor into `el`.
 *
 * Reading the built-in widget out of the registry is a *read*, not a patch: nothing is replaced, so
 * there is no restore to get right and no way to collide with another plugin that has wrapped it.
 * Its return value is passed straight through rather than repackaged: the contract documents
 * `{ focus }`, but a release that returns more should keep it.
 *
 * The entry read may be another plugin's wrapper rather than Obsidian's own widget, and it is
 * called through as it stands. That is the whole benefit of reading rather than replacing: whatever
 * is in the registry is what the reader has chosen to have there.
 *
 * Only when there is no built-in widget to borrow — an Obsidian that renamed the type, or a
 * stripped-down one — does this fall back to a plain `<input>`. That is enough to keep the property
 * editable, which is the point of having a fallback at all.
 */
function drawBuiltin(
  widgets: Record<string, unknown>,
  spec: ZonedTypeSpec,
  el: HTMLElement,
  plain: string,
  ctx: { onChange?: (value: unknown) => void; },
): unknown {
  const builtin = widgets[spec.builtin] as PropertyWidget | undefined;
  if (typeof builtin?.render === "function") {
    return builtin.render.call(builtin, el, plain, ctx);
  }

  const input = el.createEl("input", {
    type: spec.withTime ? "datetime-local" : "date",
    cls: "numbat-zoned-date-input",
  });
  input.value = plain;
  input.addEventListener("change", () => ctx.onChange?.(input.value));
  return { focus: () => input.focus() };
}
