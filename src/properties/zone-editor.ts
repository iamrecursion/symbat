// The zone field and the write-through logic behind it, shared by the two types that need them:
// `Zoned Date` and `Zoned Datetime` (both properties/date-type.ts).
//
// They differ in one thing — whether the value carries a time of day, and so which built-in editor
// draws the calendar half — so that is the only thing {@link buildZoneEditor} takes as a parameter.
// Everything else is identical, and the two subtle rules below are precisely what a second copy
// would drift on.

import { AbstractInputSuggest, type App, prepareFuzzySearch, renderResults, type SearchResult } from "obsidian";
import type { PropertyWidgetContext } from "./note";
import {
  applyZone,
  availableZones,
  offsetChoice,
  parseZoned,
  plainForm,
  selectedChoice,
  type ZoneChoice,
  zoneChoices,
  zoneForName,
} from "./zone";

/** The id of the entry for no zone at all — a bare date or a naked wall clock, which is what these
 *  types write until a zone is chosen and what they write again when one is cleared. The empty
 *  string because no zone id or offset is empty, so nothing can collide with it. */
const NO_ZONE_ID = "";

/** What the field shows when nothing is chosen, as its placeholder, and what the entry that clears
 *  it is called. */
const NO_ZONE_LABEL = "No zone";

/** The narrowest the field is sized, in characters. Wide enough for `+02:00` and for the label
 *  above, so the field never collapses to a sliver in a narrow column. */
const MIN_FIELD_CHARS = 8;

/** The class the zone field carries, and — as {@link CALENDAR_INPUT} — the one thing that tells the
 *  row's two `<input>`s apart. Also a styling hook (styles.css). */
const ZONE_FIELD_CLASS = "numbat-property-zone";

/** Any `<input>` in the row that is *not* the zone field: whatever the built-in editor drew to hold
 *  the wall clock. */
const CALENDAR_INPUT = `input:not(.${ZONE_FIELD_CLASS})`;

/**
 * The most suggestions the zone field offers at once.
 *
 * The tail of the list is every zone the platform knows — four hundred or so — and a fuzzy search
 * is a *subsequence* match, so a one-character query matches almost all of them.
 * `AbstractInputSuggest` caps what it *renders* at 100 by default, so this is not the difference
 * between bounded and unbounded; it is that a hundred rows in a popover anchored to a property row
 * is a menu nobody reads past the first screenful of, and the sort has already put the best answers
 * there. Cutting our own array rather than raising Obsidian's `limit` also keeps the several
 * hundred scored objects from being handed over to be held.
 */
const MAX_SUGGESTIONS = 20;

/** What one of these editors needs that the other does not. */
export interface ZoneEditorSpec {
  /** Marker class for the row, so the two can be styled apart. */
  cls: string;

  /** Whether the built-in editor being wrapped holds a time of day. It decides what the `<input>`
   *  is fed (`2026-07-27` or `2026-07-27T10:30`) and, through that, what shape gets written back —
   *  a date must not grow a time just by being edited. */
  withTime: boolean;

  /** Draw the calendar half: Obsidian's own date or datetime editor, handed the value with its
   *  zone stripped and a context whose `onChange` re-attaches one. Returns whatever the built-in
   *  returns, which is passed on to Obsidian untouched. */
  draw: (plain: string, ctx: PropertyWidgetContext) => unknown;
}

/**
 * A built-in date editor, plus a zone field that says what its value means.
 *
 * Two rules govern this, and both follow from the metadata editor re-rendering rows liberally and
 * offering no teardown hook (properties/type.ts's `liveEditors` note is the long version):
 *
 *  - **The selected zone is re-derived from `value` on every render**, never carried across one.
 *    State kept here would be stale the moment the row redrew.
 *  - **The offset is resolved as a value is written, from the date being written** — never cached.
 *    That is what makes the picker survive daylight saving: with `Europe/London` chosen, moving the
 *    date from January to July must move the written offset from `+00:00` to `+01:00`, and only
 *    resolving at that moment can do it.
 *
 * Choosing a zone **reinterprets** the moment shown rather than converting it: the clock never
 * moves, only the offset written beside it. That is the right behavior for a control whose job is
 * to say what an already-written value meant, and it is the one most likely to be "fixed" into the
 * wrong one later.
 */
export function buildZoneEditor(
  app: App,
  el: HTMLElement,
  value: unknown,
  ctx: PropertyWidgetContext,
  spec: ZoneEditorSpec,
): unknown {
  // Rows the metadata editor has since discarded, whose menus would otherwise still be open over a
  // field no longer in the document. Swept here because a render is the one moment this code is
  // reliably given — see {@link liveSuggests}.
  sweepSuggests();
  el.addClass(spec.cls);

  const parsed = parseZoned(value);
  // A value that will not parse is handed on exactly as it came, so the built-in editor can show or
  // clear it as it sees fit. Appending an offset to something that is not a moment would only make
  // it worse.
  const plain = parsed === null ? (typeof value === "string" ? value : "") : plainForm(parsed, spec.withTime);

  const choices = zoneChoices();
  let selected: ZoneChoice | null = null;
  if (parsed !== null && (parsed.zone !== null || parsed.offset !== null)) {
    selected = selectedChoice(choices, parsed);
    if (selected === null) {
      // A zone the reader does not have listed, or an offset none of the standing choices produces
      // — a note written elsewhere, or by hand. Either gets an entry of its own, so that merely
      // showing the value cannot rewrite it. The named case matters most: without it, opening
      // someone else's `[Pacific/Auckland]` note in Berlin would offer to flatten it to an offset.
      selected = (parsed.zone === null ? null : zoneForName(parsed.zone))
        ?? (parsed.offset === null ? null : offsetChoice(parsed.offset));
      if (selected !== null) {
        choices.push(selected);
      }
    }
  }

  // The last value the built-in editor reported, for the case where it has drawn no `<input>` the
  // zone handler can read.
  //
  // The zone field is an `<input>` in the same row, so it is excluded by class rather than trusted
  // to come second: a built-in that drew no input of its own would otherwise hand a zone *label*
  // back as the value's wall clock, and `2026-07-27` would be written as `Europe/Berlin`.
  let lastPlain = plain;
  const currentPlain = (): string => el.querySelector<HTMLInputElement>(CALENDAR_INPUT)?.value ?? lastPlain;

  const write = (nextPlain: string): void => {
    lastPlain = nextPlain;
    const trimmed = nextPlain.trim();
    // A cleared field is cleared, not an orphan zone looking for a date.
    if (trimmed === "") {
      ctx.onChange?.("");
      return;
    }

    // Resolved here, from the date being written, rather than from the one that was read: that is
    // what carries a named zone across a daylight saving boundary when the date is moved.
    ctx.onChange?.(applyZone(trimmed, selected?.zone ?? null, selected?.offsetAt(trimmed) ?? null));
  };

  // The built-in editors report a string, but the contract is `unknown` and nothing here should
  // depend on that: anything else is read as "no value" rather than stringified into `[object
  // Object]` and written to the note.
  const report = (next: unknown): void => write(typeof next === "string" ? next : "");
  const handle = spec.draw(plain, { ...ctx, onChange: report });

  // A thunk rather than the value: the field outlives this line, and what it shows when focus
  // leaves it is whatever has been chosen *since* — see buildZoneField.
  const field = buildZoneField(el, () => selected);
  attachZoneSuggest(app, field, {
    options: () => zoneOptions(choices),
    current: () => selected?.label ?? "",
    pick: (option) => {
      const chosen = option.resolve();
      // A name the platform will not resolve resolves to nothing, and "no zone" resolves to
      // nothing too — told apart by which was asked for. Only the second is a request to clear the
      // zone; the first is a dead end, and the field goes back to what the value still means.
      if (chosen === null && option.id !== NO_ZONE_ID) {
        showZone(field, selected);
        return;
      }

      selected = chosen;
      showZone(field, selected);
      write(currentPlain());
    },
  });

  return handle;
}

/**
 * The zone field, appended to the row: a text box that searches as it is typed.
 *
 * A `<select>` was the obvious control and the wrong one. Named zones are a list of some six
 * hundred entries, which a dropdown makes the reader scroll rather than say — and the answer to
 * that used to be a "Search zone…" entry that opened a modal, so choosing `Europe/Berlin` meant
 * opening a menu to ask for a search to open a dialog. Typing is what people do with a zone name
 * they already know,
 * and this lets them do it: the standing list is what appears with the box empty, so the short path
 * is no longer than it was.
 *
 * It shows the zone's **label**, not its written form. The two differ for the one choice whose
 * meaning follows the reader — `Local (Europe/London)` writes no such text — and the label is what
 * the row is for: saying what the value beside it means.
 *
 * `selected` is a **thunk, not a value**, and that is load-bearing rather than stylistic. The field
 * restores what is chosen whenever focus leaves it, and a zone chosen *after* the field was built
 * is the commonest thing there is to restore — so a captured value would put the row back to the
 * zone the value had when drawn, blanking a choice the moment the reader clicked away from it.
 */
function buildZoneField(el: HTMLElement, selected: () => ZoneChoice | null): HTMLInputElement {
  const field = el.createEl("input", {
    type: "text",
    cls: ZONE_FIELD_CLASS,
    attr: { placeholder: NO_ZONE_LABEL, spellcheck: "false", "aria-label": "Time zone" },
  });

  showZone(field, selected());

  // Typing replaces rather than appends, so a field already saying `Europe/Berlin` does not have to
  // be cleared before it can be searched.
  field.addEventListener("focus", () => field.select());

  // Text left in the field that named nothing is not a zone, and abandoning it is not a request to
  // change anything: what the value actually means goes back. **Nothing here writes** — every write
  // goes through a selection — so a half-typed name that loses focus cannot touch the note.
  field.addEventListener("blur", () => showZone(field, selected()));
  return field;
}

/** Show a chosen zone in the field, sized to what it says. `size` rather than CSS because the
 *  width of a zone name is the text's own business: it ranges from `Z` to a long `Local (…)`. */
function showZone(field: HTMLInputElement, selected: ZoneChoice | null): void {
  field.value = selected?.label ?? "";
  field.size = Math.max(field.value.length, NO_ZONE_LABEL.length, MIN_FIELD_CHARS);
}

/** One entry the zone field offers. */
interface ZoneOption {
  /** Stable identity — a choice's id, an IANA name, or {@link NO_ZONE_ID}. */
  id: string;

  /** What the reader sees, what is searched, and what the field holds once it is chosen. */
  label: string;

  /** Whether it belongs to the picker's curated list — what is offered before anything is typed.
   *  The rest is every zone the platform knows, which is a search result and not a menu. */
  standing: boolean;

  /** The choice this selects, or `null` for no zone at all. Resolved on selection rather than up
   *  front because for a searched name under a non-floating type it means asking `Intl` — six
   *  hundred times over, if it were done to build the list. */
  resolve: () => ZoneChoice | null;
}

/**
 * Everything the field can offer: clearing the zone, the standing choices, then every other zone
 * the platform knows.
 *
 * A name the standing list already covers is left out of the tail, so `UTC` and the reader's own
 * zone appear once each. Their standing entries are the better ones — `Local (Europe/London)` says
 * what a bare `Europe/London` does not — and two rows that select the same thing would be a menu
 * saying something untrue about itself.
 */
function zoneOptions(choices: readonly ZoneChoice[]): ZoneOption[] {
  const named = new Set(choices.map((choice) => choice.zone).filter((zone): zone is string => zone !== null));

  return [
    { id: NO_ZONE_ID, label: NO_ZONE_LABEL, standing: true, resolve: () => null },
    ...choices.map((choice) => ({ id: choice.id, label: choice.label, standing: true, resolve: () => choice })),
    ...availableZones()
      .filter((zone) => !named.has(zone))
      .map((zone) => ({ id: zone, label: zone, standing: false, resolve: () => zoneForName(zone) })),
  ];
}

/** What the field's suggestions need of the editor around it. */
interface ZoneSuggestSpec {
  /** Everything on offer, asked for per query so the list is never stale. */
  options: () => ZoneOption[];

  /** The label the field holds while nothing is being searched for — see {@link ZoneSuggest}. */
  current: () => string;

  /** Called with what the reader chose. */
  pick: (option: ZoneOption) => void;
}

/**
 * Every zone field currently alive, so the popover of one whose row has gone can be shut.
 *
 * The suggester's *listeners* need no help: they are on the field and nothing else, so they go when
 * it does. Its **popover** is the exception — `PopoverSuggest` opens into `document.body`, outside
 * the row entirely, and Chromium does not fire `blur` when a focused element is removed. The
 * metadata editor redraws rows liberally and offers no teardown hook, so a redraw while the menu is
 * open would strand it there, listening to a field that is no longer in the document.
 *
 * Module-level and swept on the next render, which is the same answer properties/type.ts's
 * `liveEditors` gives to the same missing hook.
 */
const liveSuggests = new Set<LiveSuggest>();

/** One live zone field. `attached` is what tells a row that has *gone* from one that has not
 *  arrived yet: Obsidian inserts a property row after rendering it, so a field is normally still
 *  detached when it is registered, and sweeping on that alone would shut every menu at birth. */
interface LiveSuggest {
  field: HTMLInputElement;
  suggest: ZoneSuggest;
  attached: boolean;
}

/** Close and forget the suggesters whose rows are gone, and (on unload) all of them. */
function sweepSuggests(all = false): void {
  for (const entry of [...liveSuggests]) {
    if (all) {
      entry.suggest.close();
      liveSuggests.delete(entry);
      continue;
    }

    if (entry.field.isConnected) {
      entry.attached = true;
    } else if (entry.attached) {
      entry.suggest.close();
      liveSuggests.delete(entry);
    }
  }
}

/** Shut every open zone menu, for plugin unload. The rows themselves are Obsidian's to remove. */
export function disposeZoneEditors(): void {
  sweepSuggests(true);
}

/** Attach the type-ahead to the field, and register it for the sweep above. */
function attachZoneSuggest(app: App, field: HTMLInputElement, spec: ZoneSuggestSpec): void {
  liveSuggests.add({ field, suggest: new ZoneSuggest(app, field, spec), attached: field.isConnected });
}

/** A scored option, kept together so the matched characters can be highlighted as the list is
 *  drawn. `match` is `null` for a standing entry shown without a query to match against. */
interface ScoredOption {
  option: ZoneOption;
  match: SearchResult | null;
}

/**
 * The field's type-ahead: the standing list while nothing has been typed, and a fuzzy search over
 * every zone the platform knows once something has.
 *
 * **The field's own contents are not a query.** It holds the current zone's label, so a reader who
 * focuses it would otherwise be shown a search for `Local (Europe/London)` — a list of one, and the
 * one they already have. Reading that as "nothing typed yet" is what makes focusing the field open
 * the menu the `<select>` used to, which is the short path this must not cost anyone.
 */
class ZoneSuggest extends AbstractInputSuggest<ScoredOption> {
  constructor(app: App, field: HTMLInputElement, private readonly spec: ZoneSuggestSpec) {
    super(app, field);
  }

  getSuggestions(query: string): ScoredOption[] {
    const text = query.trim();
    const options = this.spec.options();
    if (text === "" || text === this.spec.current()) {
      return options.filter((option) => option.standing).map((option) => ({ option, match: null }));
    }

    const search = prepareFuzzySearch(text);
    const scored: ScoredOption[] = [];
    for (const option of options) {
      const match = search(option.label);
      if (match !== null) {
        scored.push({ option, match });
      }
    }

    // Sorted before it is cut, so the cap drops the worst matches rather than the ones the platform
    // happened to list last.
    scored.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
    return scored.slice(0, MAX_SUGGESTIONS);
  }

  renderSuggestion({ option, match }: ScoredOption, el: HTMLElement): void {
    if (match === null) {
      el.setText(option.label);
      return;
    }
    renderResults(el, option.label, match);
  }

  selectSuggestion({ option }: ScoredOption): void {
    this.close();
    this.spec.pick(option);
  }
}
