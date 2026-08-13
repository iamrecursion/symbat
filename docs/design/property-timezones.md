# Design Note: Time Zones on Date Properties

**Status:** Implemented

A frontmatter date binds into Numbat as a `DateTime`, so the zone it is read in is arithmetic rather
than presentation. Obsidian gives a note no way to state that zone: its Date type holds `2026-07-27`
and nothing else, and its Datetime type can hold an offset but offers no way to set one and discards
any written by hand as soon as the widget writes. This note records what was measured to decide the
shape of the fix — including a mechanism that was built, shipped behind a setting, and then removed
(see [Why the Datetime Patch Was Removed](#why-the-datetime-patch-was-removed)).

## What the Platform Actually Does

Measured against the `js-yaml` and `moment` in `node_modules` — which is what Obsidian's `parseYaml`
and its property widgets are built on — rather than assumed:

| Value                        | `parseYaml`                                   | moment                      |
| ---------------------------- | --------------------------------------------- | --------------------------- |
| `2026-07-27`                 | `Date`                                        | valid                       |
| `2026-07-27 +02:00`          | **plain string, verbatim**                    | **invalid**, strict and lax |
| `2026-07-27+02:00`           | **plain string, verbatim**                    | **invalid**, strict and lax |
| `2026-07-27T10:30+02:00`     | plain string — no seconds, so not a timestamp | valid                       |
| `2026-07-27T10:30:00+02:00`  | `Date`, offset already collapsed              | valid                       |
| `2026-07-27 [Europe/Berlin]` | **plain string, verbatim**                    | **invalid**                 |
| `2026-07-27[Europe/Berlin]`  | **plain string, verbatim**                    | **invalid**                 |
| `…+02:00[Europe/Berlin]`     | **plain string, verbatim**                    | **invalid**                 |

Three consequences, and between them they decide the whole design:

1. A date with an offset suffix **survives both read paths untouched**, so it needs no protection
   from the parser and the two surfaces cannot disagree about it.
2. It is **invalid to moment**, so it must not live under Obsidian's built-in Date type: Bases date
   columns, filters, sorting and other plugins would all see a broken value, and with Symbat
   disabled the property would be unreadable.
3. The "reads two ways" bug was **narrower than the old roadmap entry claimed**: only values
   carrying seconds ever became a `Date`. That is still the real case, because `HH:MM:SS` is exactly
   what Obsidian's datetime widget writes — but it made the fix small and precisely testable.

RFC 9557 was probed separately, because the bracketed zone name is the only way a value can _float_
— say which zone was meant, so that moving its date across a daylight saving boundary moves the
instant with it, where an offset pins one instant forever. moment 2.29 rejects it in strict
`ISO_8601` mode, in lenient mode, and `new Date()` returns `Invalid Date`; only a caller passing an
explicit format string reads it, by ignoring the bracket. moment has been frozen for years and RFC
9557 was published in 2024, so this is unlikely to change.

That settled the last open question: a floating zone cannot live under Obsidian's built-in Datetime
type either. The floating form therefore gets a `Zoned Datetime` type alongside `Zoned Date`, and
those two are now the whole feature.

## Two Types, No Patches

**Neither zoned spelling is standard**, which is what decides the mechanism. There is no standard
way to write "a day, in a zone" at all, so this plugin invents one (`2026-07-27 +02:00`); and the
RFC 9557 form that lets a datetime _float_ is read by neither moment nor `Date`. Both therefore live
under **types of our own**, `numbat:zoneddate` and `numbat:zoneddatetime`. Under our own ids nothing
expects the values to be native dates, so no contract is broken; under Obsidian's Date and Datetime
types one would be. Obsidian's own widgets are left completely alone.

Both types share `properties/zone-editor.ts`, differing only in whether the value carries a time of
day, so the two cannot drift apart on the rules below.

The space in front of a date's zone is the one place the invented spelling was chosen for the eye
rather than for a parser. `2026-07-27-07:00` reads as four dash-separated numbers and you have to
count digits to find where the date stops. The measurements above are indifferent to it — with the
space and without, the value is a plain string to `parseYaml` and invalid to moment, which is the
whole reason a date needs its own type either way — and `DATE_TEXT` already admitted it, so the form
written before this still reads. A value with a _clock_ keeps no space: that one is real RFC 3339,
and other software reads it.

The zone control is a **text field with a type-ahead** (`AbstractInputSuggest`), not a `<select>`.
Named zones number some six hundred, which a dropdown makes you scroll rather than say; the first
version answered that with a "Search zone…" entry that opened a modal, so choosing `Europe/Berlin`
meant opening a menu to ask for a search to open a dialog. Typing is what anyone does with a name
they already know. The short path is not lost: an empty box offers the same standing list the
`<select>` held, and focusing the field opens it, so the curated choices stay one click away. Two
consequences are load-bearing — **nothing is written except by a selection**, so text typed and
abandoned cannot touch the note; and the row's calendar `<input>` is now found by
`input:not(.numbat-property-zone)`, because the zone field is an `<input>` in the same row and a
built-in that drew none of its own would otherwise have a zone _label_ written back as a wall clock.

## Showing a Value in the Zone It Names

Storing the zone is half the job. Numbat renders every `DateTime` in the zone of the machine it is
running on, so `2026-07-27T09:00:00-07:00` reads back as `18:00 CEST` to someone in Berlin: the same
instant, converted correctly, and not the 9am the note is about. A property that says when something
happens is read far more often than it is subtracted from another, so the clock it shows is the
feature.

The binding therefore ends in `-> tz("…")` when — and only when — the value itself names a zone.
Three things make this safe to put in the binding rather than in some display-only path:

- **`tz` returns a `DateTime`**, not a string (`fn tz(tz: String) -> Fn[(DateTime) -> DateTime]`).
  The value is the same moment either way, so arithmetic against it is untouched and every consumer
  — inlays, the widget, the scope inspector, another note importing this one — agrees.
- **It composes anywhere a value can go.** Verified in a live interpreter inside `let`, inside a
  struct literal (which is what an object property binds to) and inside a list.
- **A value read at the _default_ zone gets none of this.** That zone is the reader's own, which is
  the one Numbat would have shown it in anyway, so the conversion would be a no-op with a zone name
  stapled to it.

What each case can name is the whole of the subtlety:

| The value carries  | Shown in                 | Why                                                              |
| ------------------ | ------------------------ | ---------------------------------------------------------------- |
| `[Europe/Berlin]`  | `Europe/Berlin`          | The name is what was written; `tz` takes exactly this.           |
| `Z`, `+00:00`      | `UTC`                    | Two spellings of one zone, and it has a real name.               |
| `-05:00`, `+02:00` | `Etc/GMT+5`, `Etc/GMT-2` | Fixed by definition, so displaying in one cannot move the clock. |
| `+05:45`, `-03:30` | the reader's own         | No fixed-offset zone exists for a fractional offset.             |
| nothing (default)  | the reader's own         | See above.                                                       |

The `Etc/GMT` sign inversion is POSIX's and the database has kept it: `Etc/GMT+5` **is** UTC−05:00.
It reads like a bug in every diff it appears in, which is why `fixedDisplayZone` says so at length.

The fractional-offset row is a deliberate gap. The alternative is to name a _place_ sitting at that
offset — `Asia/Kathmandu` for `+05:45` — which puts a location into a value that never claimed one,
and for the ones that observe daylight saving would show the wrong clock half the year. Picking the
zone by name rather than by offset gets the right answer and says more; that is the path the widget
already pushes you toward.

Out-of-range offsets get nothing for a harder reason: `tz("Etc/GMT+13")` names a zone that does not
exist and is a **runtime error**, which would fail the binding outright. Showing a value in the
reader's zone is a worse reading; failing to bind it is no reading at all.

## Rejected Alternatives

- **A side store** (zone per key, in plugin data). Grows without bound, goes stale against renames,
  and does not travel with the note — the value would mean one thing in your vault and another in a
  copy of it.
- **A sibling property** (`due` plus `due-tz`). Keeps the date native and would have worked, at the
  cost of doubling the frontmatter keys for dates and needing `processFrontMatter` to write two keys
  where the widget contract writes one.
- **A per-note zone key.** One key covering every date in a note. Cheap and clean, but not
  per-value, and the vault-wide default setting already covers most of what it would have bought.
- **The suffix under Obsidian's Date type.** Rejected on measurement 2 above.
- **Reimplementing the date picker.** Would mean owning Obsidian's mobile pickers, calendar popover,
  keyboard entry, theming and accessibility, on a _core_ type, for the sake of one zone field.
- **Patching the metadata editor's save path.** Worse for less: unreachable without instantiating a
  view to steal a prototype, shared by every property in the vault, nowhere to put UI, and a mistake
  corrupts writes we know nothing about.

## Why the Datetime Patch Was Removed

The first implementation also **patched Obsidian's built-in Datetime widget**, behind a setting that
was off by default, replacing `registeredTypeWidgets.datetime` with an `Object.create` of the
original and overriding `render` alone. The reasoning was that `2026-07-27T10:30:00+02:00` is valid
ISO 8601, a valid YAML timestamp and a valid moment, so adding a zone to a _core_ type took nothing
away from anyone. That is still true, and it was still the wrong trade.

What it cost, all of it structural rather than a bug to be fixed:

- **It inherits Obsidian's changes to a widget we do not own.** Every release can alter the entry's
  shape, its return contract, or how the metadata editor calls it. The probes below were true when
  taken and have no way to stay true.
- **It has to be undone exactly.** Restoring is only safe if the entry is still the one we installed
  — a plugin that wrapped ours after we installed must keep its wrapper — so the uninstall carries
  an ownership `Symbol` read as an **own** property, while the install has to read the same brand
  _through_ the prototype chain to detect an already-installed patch. Two readings of one brand,
  each of which silently breaks something if given the other's answer.
- **It nests with our own types.** `Zoned Datetime` borrows the `datetime` registry entry to draw
  its clock — which, with the patch on, _is_ the patch. That opened a second zone field inside the
  first, each appending its offset to the other's output, and needed a re-entrancy guard in
  `zone-editor.ts` to prevent.
- **It could not be tested.** The widgets import Obsidian, so every rule above was pinned by a
  comment rather than by a test.

`Zoned Datetime` covers the same ground with none of that: it owns its id, it is registered rather
than substituted, and nothing has to be restored. A value written while the setting was on is an
ordinary zoned timestamp and still binds; assigning it the `Zoned Datetime` type gets the zone field
back. What was lost is the ability to zone a value while it stays under Obsidian's _own_ Datetime
type — which was always the narrower half, since that type discards the offset whenever its widget
writes.

Kept for the record, because they are what anyone reconsidering this would have to re-probe:

- `registeredTypeWidgets.datetime` was `{ type, icon, name, validate, render }`.
- `validate("2026-07-27T10:30:00+02:00")` already returned `true`, so nothing needed widening.
- Obsidian wrote the string the widget handed `onChange` rather than re-normalizing it through
  moment. This was the load-bearing assumption; had it changed, the fallback would have been the
  public `app.fileManager.processFrontMatter`, at the cost of a race against the editor's own save
  and of sitting outside its undo grouping.

## Rules That Look Like Details and Are Not

- **The offset is resolved when a value is written, from the date being written** — never cached.
  With `Europe/London` selected, moving a date from January to July must move the written offset
  from `+00:00` to `+01:00`.
- **Resolving a zone offset from a wall clock takes two passes**, because the instant a wall clock
  names depends on the offset being looked up. Read it as if the wall clock were UTC, subtract, read
  again. A one-pass version passes the July case and fails the January one, which is why
  `test/unit/properties/zone.test.ts` pins both.
- **The selected zone is re-derived from the value on every render**, never carried across one: the
  metadata editor redraws rows freely and there is no teardown hook.
- **Choosing a zone reinterprets rather than converts.** The clock stays where it is; only the
  offset beside it changes. The job is to say what an already-written value meant.
- **What reaches `datetime("…")` is always an offset.** Numbat gets at IANA names only through
  `-> tz(...)`, so a stored zone name is resolved to the offset it had _at that value's own wall
  clock_ before the binding is emitted. Storing the name is what makes the value float; resolving
  per-read is what makes it correct. The name is then handed to `tz` on the end, which is a
  statement about display and not about which instant this is — see above.
- **A name outranks an offset written beside it.** RFC 9557 permits both, and its own rule makes the
  offset authoritative. This goes the other way deliberately: the name is the only half that is
  still true after the date beside it is edited, so a stale `+02:00` in front of `[Europe/Berlin]`
  is corrected rather than obeyed.
- **A named value is matched back by name, never by number.** Matching on the offset would show
  `Europe/Paris` half the year and a bare `+01:00` the rest — and, worse, an offset-only value would
  select a named zone and silently become floating on the next edit. An offset-only value therefore
  only ever matches a fixed-offset entry.
- **A bare date stays bare.** The suffix is optional, nothing promotes a date to a timestamp, and
  the quoting pass that protects zoned timestamps from the YAML parser only touches values that
  already carry an offset.
