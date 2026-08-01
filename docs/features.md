# Feature Reference

This document contains every feature of Symbat in detail, with reference to the settings that
influence how it behaves. For a shorter tour, see the README's
[key features](../README.md#key-features). For how the pieces fit together, take a look at the
[architecture doc](./architecture.md).

Throughout, we use **Numbat** means the [calculator language](https://numbat.dev) that the plugin
embeds. **Symbat**, on the other hand is the plugin.

Write a fenced code block with the `numbat` language:

````markdown
```numbat
3 miles / 40 min -> km/h
```
````

Or share state across a note with `numbat-shared`:

````markdown
```numbat-shared
let income = 60000 € / year
```

```numbat-shared
income -> £ / month
```
````

## Clearing the Screen

Press `Ctrl+L` in the REPL to clear the screen, shell-style: the current output scrolls up out of
view but stays in the scrollback (scroll back up to see it again). Unlike the `clear` command
nothing is discarded, and unlike `reset` the interpreter session is untouched. It works in every
mode, including Vim normal mode.

## Commenting

Inside a `numbat` / `numbat-shared` block, the editor's **Toggle comment** shortcut (default
`Ctrl/Cmd + /`) inserts and removes Numbat `#` line comments rather than Markdown ones — on the
current line or across the whole selection. Outside a numbat block it ts behavior is unchanged.

## Custom Preludes

Enable **Custom prelude** in the plugin settings and add one or more `.nbt` files, each with an
optional name. They are loaded in the order listed (which you can rearrange), after Numbat's
standard prelude, so their definitions (custom units, constants, and functions) become available to
every `numbat` and `numbat-shared` block, and to the REPL.

Changes to the files are picked up automatically, and if you move or rename a file the plugin
updates its path for you. If a prelude fails to parse, the error is shown in the REPL (and logged to
the developer console).

## Expression Completion

As you type an expression — either two characters into a word, or straight after a `.`, a `:`, a
generic type's `<`, or a `fn` declaration's return `->` — a completer offers matching Numbat names,
in any context where you can write Numbat code.

It is backed by Numbat's own completion engine, so it knows the whole standard library, your custom
preludes, and whatever you've already written: in the REPL, anything defined this session; in a code
block, the definitions above the cursor (the code before it is replayed in the background, and for a
`numbat-shared` block the earlier shared blocks and properties in the note too).

A `let`, `unit`, or `fn` you wrote higher up completes lower down. Each completion is tagged with
its kind — variable, function, unit, dimension, type, or keyword — colored as it would be in code.
Five independent toggles under **Expression completion** each gate one kind:

- **Complete identifiers** includes variables, constants, and functions (`pi`, `c`, `sin`, …).
- **Complete keywords** includes keywords and operators (`to`, `per`, `let`, `if`, `where`, …).
- **Complete units** includes units (`meter`, `second`, `newton`, …), including metric-prefixed
  forms such as `kilometer`.
- **Complete dimensions** includes physical dimensions (`Length`, `Time`, `Mass`, …).
- **Complete types** includes built-in and structural types (`Bool`, `String`, struct, …).

Each row carries its **type signature** after the name (e.g. `abs : forall A: Dim. Fn[(A) -> A]`,
`meter : Length`), muted and truncated so it never crowds out the name.

If you pause on a completion for a moment, a **documentation popup** opens above the completer. Its
field labels (**Function**, **Signature**, **Description**, **Aliases**, …) are bolded, inline `$…$`
math in a description is rendered with MathJax, and every non-function entry gains a **Type** field
carrying its `type()` result. A reference URL, where Numbat has one, is shown as a link at the foot
of the popup.

Completion follows the expression wherever it is written: `numbat` blocks, inline spans, the REPL,
and — since a property's value _is_ Numbat source — the **Numbat property field** and the raw YAML
of a Numbat-typed property in **Source mode**. In the properties panel the field is a small Numbat
editor, so it also highlights as you type, expands `\unicode`, and shows the missing-operand
placeholder. Each completes against the scope that property actually has: the note's imports and the
properties written above it.

After a `.`, the completer offers the **fields** of the struct to its left — a note's nested
properties (`costs.` → `materials`, `labor`, …) and your own `struct` values alike — each with the
type of that field.

The two-character minimum keeps the popover from flickering on every keystroke, while the `.`, `:`,
`<`, and return-`->` triggers let member and type positions complete from the first character. A
type position — a `:` annotation (`let x: Length`, `fn f(a: Time)`), a just-opened generic list
(`List<`), or a `fn` declaration's return arrow (`fn f(…) ->`) — offers **types, dimensions, and
units**, not variables, functions, or keywords, and a `:` annotation stays open across the
conventional space (`: Type`).

Where the surrounding syntax narrows what is accepted it is honored: the `:` of a `unit foo:`
declaration and the body of a `dimension Foo = …` both offer **dimensions only**, and a type
parameter bound (`fn foo<D:`) offers exactly **`Dim`**, the only bound the grammar admits. A
declaration's own **type parameters** complete at its type positions — `D` is offered inside
`fn mean<D: Dim>(xs: List<D>) -> D` while the declaration is still open (through a multi-line
signature, the body, and `where`/`and` clauses), and drops out of the list after it ends. A
`Dim`-bounded parameter is tagged and colored as a **dimension** (it stands for one); an unbounded
one as a **type**.

The `<` trigger recognizes a capitalized name touching its `<` (`List<`), so a spaced comparison
(`a < b`) never opens it. The unicode and history leaders take precedence, so typing a `\code` or a
`?:` history query never triggers expression completion.

Navigate the popover with the arrow keys, emacs-style Ctrl-N / Ctrl-P, or Tab to accept. The first
completion after the plugin loads shows a brief “Loading Numbat…” placeholder while the interpreter
initializes. None of this runs, and no code is replayed, unless **Expression completion** is enabled
and so you can turn the whole feature off with that setting.

To avoid keeping a large replayed block context resident in the background, the cached completion
interpreters are freed after a period without a completion (they rebuild on next use). The delay is
configurable under **Runtime → Free the interpreter when idle**. Set it to 0 to keep them loaded.

## History Completion

In the REPL, type the **History leader** (`?:` by default) to open a completer of your previous
inputs in the same native popover. The text you type after the leader fuzzy-filters the list, and
choosing an entry fills the input with it.

Navigate it with the arrow keys or emacs-style Ctrl-N / Ctrl-P. This is independent of the arrow-key
recall (Up/Down on an empty or prefix line), which still steps through history in place. Turn it
off, or change its leader, with the **History completion** and **History leader** settings.

## Hover Information

That documentation popup is also reachable without completing anything: **point at a symbol** and it
opens for whatever is under the pointer. The card contains the same information as seen in the
autocomplete popup.

Two things open it, each with its own toggle under **Hover information**:

- **Hover with the mouse**, which is resting the pointer on a symbol.
- **Hover on cursor dwell**, which is resting the _caret_ on one. Moving to a symbol opens the card;
  typing never does, so it stays out of the way while you write. It is also how hover works on
  mobile, where a tap places the caret.

Both wait out the same configurable **hover delay**, and neither fires while a completer is on
screen.

Hover applies wherever the note's text _is_ Numbat source: `numbat` / `numbat-shared` blocks, inline
spans, a Numbat-typed property's value in Source mode, the REPL input, and the Numbat property
field. Each resolves the symbol against the scope that position actually has (the same replay the
completer uses) so a name means the same thing hovered as it does evaluated. Prose is never hovered,
and neither is a _rendered_ block: hover reads the document, and a rendered block's source is not in
it.

Not everything worth hovering is a name the interpreter knows, so three kinds have cards of their
own.

- A **struct field** (`costs.total`) is typed and evaluated rather than documented; Numbat exposes
  docs by name, and a member path is not one.
- A **literal** is read with the unit that follows it, so hovering the `21.1` of `21.1 km` answers
  `Length`, not nothing.
- A **parameter**, a **type parameter**, or a **field in a `struct` declaration** exists only inside
  the declaration that introduces it, where no context has ever heard of it — so its card is what
  the declaration says: the kind, the declared type, and which `fn` or `struct` it belongs to, found
  from the body as well as the signature.

A symbol **you** defined also gets a **Go to definition** row, with where it lives noted beside it;
clicking or tapping it jumps there. This can take you to a frontmatter key (the nested one, for
`costs.total`), the line in the block or inline span that declares it, the note it was imported
from, or your own `.nbt` prelude file. Numbat's own prelude has no such row: there is nothing in the
vault to open.

The **Show info at the cursor** command provides the same hover functionality, and can be
arbitrarily bound.

With **Vim key bindings** on, a caret dwell counts in **insert** mode only; in normal mode the caret
is a cursor being moved, not a pointer. Normal mode gets a key of its own instead (**Shift+H** by
default, but configurable). The **Show info at the cursor** command does the same thing from any
hotkey, with or without Vim.

## Inline Expression Evaluation

Beyond code blocks, you can compute a Numbat expression **inline, mid-sentence**, by putting a short
prefix on an inline code span. There are two kinds:

- **Live** — `` n`expr` ``, where the expression is evaluated as you type and its result shown just
  after the span, e.g. `` n`5 km + 3 mi` `` renders (in Source mode / Live Preview) as
  `` n`5 km + 3 mi` `` followed by a bright `= 9.82803 km`. The result is a hint, not part of the
  note. You can **click the result to commit** the value into the text, or run **Commit all visible
  inline evaluations** from the command palette to bake in every one currently on screen at once.
- **Concrete** — `` nc`expr` ``, where the value is continually written **into the source text**,
  right of a `⇒` separator, and kept in sync every time the expression changes:
  `` nc`5 km + 3 mi` `` becomes `` nc`5 km + 3 mi ⇒ 9.82803 km` ``. When you edit to the left of the
  `⇒` the plugin automatically keeps the right in sync. The value lands once the caret leaves the
  span — never mid-typing — and you don't type the separator yourself, though a typed `=>` works
  too: It is recognized and normalized to `⇒` on the next write. Delete the whole span to remove it.

Both prefixes are dimmed and the expression is syntax-highlighted, so a span reads as a little
calculation rather than plain code. Results show as `= value`, without the `[Dimension]` annotation
code blocks append. Whether a **commit** keeps the expression (`5 km + 3 mi = 9.82803 km`) or
replaces it with just the value is a plugin setting.

A span that has no value still tells you _why_, as a muted hint after the span: an erroring
expression shows its diagnostic's summary line, an incomplete one shows the missing operand's type
as a placeholder (`` n`3 m + ` `` shows `⟨Length⟩`, just like code blocks and the REPL input), and a
`let` binding whose value is non-trivial shows what it bound (`` n`let x = 1 + 3` `` shows `= 4`;
omitted when it would only repeat the source).

A binding's hint is informational — clicking does nothing and the commit command skips it, since
committing would delete the definition.

Results can be displayed with a **fixed number of decimal places**, truncating or zero-padding as
needed (`5 + 25/60` at two places shows `5.42`; `1.5` at three shows `1.500`; units ride along:
`9.83 km`).

The formatting is Numbat's own (using its string format specifiers), so what you see is exactly what
Numbat prints. Set a default under **Inline evaluation → Default decimal places** (leaving it blank
for full precision), or configure a single span with a `{…}` block immediately after the opening
backtick: `` n`{dp=3} 5 + 25/60` `` shows `5.417`, and `` n`{dp=} …` `` returns that span to full
precision even when a default is set.

Config parameters are comma-separated `key = value` pairs. The value is optional, but the `=` is
not: a bare `` n`{dp} …` `` is a config syntax error, surfaced after the span like any other error
(as is a non-numeric value such as `{dp=lots}`). `dp` is the only supported parameter so far. The
rounded text is also what a commit or an `nc` materialization writes. A value that has no decimal
representation (a string, boolean, list, …) simply shows un-rounded.

The editor affordances follow you inline: while the caret is in a span's expression, **expression
completion** (with its signature and documentation popups) and **unicode expansion** (`\alpha` →
`α`, including the `\code` completer) work exactly as they do in `numbat` code blocks. In this
context, completions see the note's `numbat-shared` blocks and earlier inline expressions, so your
own definitions complete.

Inline expressions **share the note's state**: an expression sees every `numbat-shared` block above
it _and_ every earlier inline expression, evaluated in document order — so `` n`let rate = 3 %` ``
up the page makes `` n`1000 € * rate` `` below it work. Plain `numbat` blocks stay independent and
are not shared.

Inline evaluation always works in **prose**. It can additionally work in **YAML frontmatter**
(compute a property value) and inside **other fenced code blocks** (`` ```python ``, a plain
`` ``` `` scratch block, …) — each of those two contexts is its own toggle under **Inline
evaluation**, revealed by the master switch. A `numbat` block's own contents are always left to the
block's own evaluation, so a `` n`…` ``-looking token there is never touched.

Because frontmatter and code blocks are not rendered as prose, their results appear **while editing
in Source mode** (and in Live Preview while the caret is in that block); in reading view they render
as their normal properties/code. `nc` writes its `⇒ value` into whatever it sits in, including YAML
and code — so prefer the non-writing `n` there unless you want that.

In **reading view** a prose inline evaluation renders as just its value by default, or as
`expression = value`, per **Inline evaluation → Reading-view display**. If an expression errors, its
raw text is left untouched rather than showing a broken value.

All of the feature's settings live under the **Inline evaluation** section: turn it on or off,
choose the reading-view style and the commit style, change the `n` / `nc` prefixes, set the default
decimal places, and toggle the frontmatter and code-block scopes.

## Inline Results and Type Hints

While you edit a `numbat` or `numbat-shared` block in Source mode or Live Preview, the plugin
evaluates it line by line and shows each line's outcome inline, as muted hints that color like the
block:

- An **expression's result** at the end of the line — `2 km + 3 m` shows `= 2003 m [Length]`;
- A **binding's inferred type** just after its name, where you did not annotate one —
  `let speed = 80 km/h` shows `let speed: Velocity`; if you write the type yourself, no hint is
  added;
- A **`let` binding's evaluated value** at the end of the line — `let x = 1 + 3` shows
  `let x: Scalar = 1 + 3 = 4` (the `[dimension]` is dropped, since the type is already inline); it
  is omitted when the value would just repeat the source, as in `let x = 5 m`;
- For an **incomplete expression**, the type of the operand it is still missing, as a placeholder —
  `3 m +` shows `⟨Length⟩`, and `sin(` shows `⟨Scalar⟩` — obtained from Numbat's typed holes;
- For a **statement that fails to evaluate** (and offers no such hole), the diagnostic's summary at
  the end of the line — `abs(-5` shows `Missing closing parenthesis ')'` in the error color, just as
  an inline-eval span would.

A bracketed expression spanning several lines (`abs(` … `)`) is valid Numbat and evaluates as one
statement: its result sits at the end of its last line, and its intermediate lines are never flagged
as errors.

The hints are display-only (never selected or copied) and update as you type. The type hints appear
wherever the interpreter can name a type — for each binding and each complete line — not for every
subexpression. Turn the whole feature off, or just the results or the type hints, under **Editor →
Inline results and type hints** (error summaries follow the results toggle). In reading view, a
block still renders its result using the bare numbat renderer.

The **REPL input** shows the incomplete-expression placeholder too: type `3 m +` and a muted
`⟨Length⟩` appears at the end of the input, resolved against the live session (so names you defined
earlier in the REPL session are in scope). It follows the same **Show type hints** toggle.

## Live REPL Highlighting

The REPL input is syntax-highlighted as you type, using the same token colors as `numbat` code
blocks. Keywords, numbers, strings, operators, comments, and decorators all take their theme color,
so an expression reads the same in the REPL as it would in a block.

It is purely visual: the caret, selection, history recall, unicode expansion, and completers all
behave exactly as before. Turn it off with the **Live REPL highlighting** setting to type against
plain text.

## Markdown Auto-Pairing

Obsidian's **Auto pair Markdown syntax** setting pairs `*` and `_` as emphasis markers as you type.
Inside numbat code — a `numbat` / `numbat-shared` block, an inline evaluation's expression, or the
value of a Numbat-typed property in a note's frontmatter — those characters are multiplication and
part of identifiers, so the plugin suppresses the pairing there: typing `*` or `_` inserts just that
character.

The frontmatter case covers editing the YAML directly in Source mode; the property editor's own
input never paired, since it is not a Markdown editor. It follows the **Note properties** setting,
because a property's value is only an expression while that is on, and it applies to the value half
of the line alone. A property whose _name_ you are typing is _still prose_.

Prose (and the rest of Obsidian's pairing, such as brackets) is unaffected.

## Note Properties

Frontmatter properties can feed the note's Numbat scope, in two ways:

- **Numbat Property Type:** The plugin registers a **Numbat** property type; assign it to a property
  from the type menu in the properties panel (type assignments are per property _name_, vault-wide —
  like Obsidian's own types). A Numbat property holds an **expression as text** (`5 km + 3 mi`,
  `40 EUR / 1 h`, `2 * pi`), edited in a monospace input that shows a live, muted `= value` right
  next to it — or the error, or a `⟨Type⟩` placeholder while the expression is incomplete, exactly
  like inline evaluation.
- **Plain Numbers:** An property whose value is just a number (`hours: 3`) binds as a dimensionless
  scalar (toggleable). This works for untyped numeric properties and `number`-typed properties.

A **list** property binds as a Numbat list, so the whole of Numbat's list vocabulary applies to it:

```yaml
weights: [70, 72, 71]        # sum, mean, len, map, element_at …
rates:                       # Numbat-typed: each item is an expression
  - 5 EUR
  - 3 EUR
costs:
  items: [500, 300]
  total: sum(costs.items)    # = 800
```

Numbat lists hold one type, so a mixed list (`[1, "a"]`) cannot bind — a typed one reports Numbat's
own type error on the property. Untyped lists join only when every item is a plain number, so `tags`
and other prose metadata stay out of the note's namespace; and a list of objects does not bind.

Properties **nested inside a YAML object** count too, under both rules, however deep. An object
binds as a Numbat _struct_ named after its own key, so each property is addressed by the dotted path
Obsidian already shows you — and siblings can reference each other by it:

```yaml
costs:
  materials: 500 EUR    # Numbat-typed
  labor: 300 EUR       # Numbat-typed
  total: costs.materials + costs.labor    # = 800 €
```

The struct's type is named after the property (`costs` has type `CostsStruct`, a nested `breakdown`
has `CostsBreakdownStruct`), so it reads as itself wherever a type is shown.

`costs.total` is then usable anywhere in the note, and `costs` itself is a value
(`CostsStruct { materials: 500 €, labor: 300 €, total: 800 € }`). Typing `costs.` in a block or an
inline span completes the fields, each with its associated type.

Four things to know about nesting:

- A property nested under an object may be named after a **unit** freely — `si: { m: 5 }` binds
  `si.m` and leaves `5 m` meaning five meters. The name collision guard below applies to the
  **object's own key**, which does bind a top-level Numbat name.
- A handful of names are Numbat keywords and cannot be struct fields (`type`, `to`, `unit`, `print`,
  `and`, `if`, …). Such a property is skipped, with the reason shown — the same words are already
  unusable as top-level property names.
- If one nested property fails to evaluate, the object **stops being rebuilt** at that point: the
  broken property shows its own error as always, and the ones after it still evaluate on their own,
  but they **cannot be reached through the object** until it is fixed.
- YAML **lists** are not descended into (a list item has no `key:` line to anchor a result on, and
  no struct field can name an index).

Assigning the Numbat type to a nested property needs the
[Better Properties](https://github.com/unxok/better-properties) plugin, which is the only way to
reach a nested property's type menu. Nested **plain numbers**, however, work with no extra plugin.

Every binding is then in scope for **everything in the note** — plain `numbat` blocks,
`numbat-shared` blocks, inline `` n`…` `` expressions, and their completions: a note with
`distance: 21.1 km` (typed Numbat) can write `` n`distance -> mi` `` in prose or use `distance` in
any block. Bindings apply in **frontmatter order**, before everything else in the note, so a later
property can reference an earlier one, and a property expression never sees the note's blocks, only
the properties above it.

When you edit the frontmatter as raw YAML in **Source mode**, each bound property shows the same
muted `= value` (or `⟨Type⟩` / error) at the end of its line that a `numbat` block line does, so you
get the result without leaving the text. In Live Preview and reading view the property widget shows
it instead. This follows the inlay-hint settings and is suppressed for a value that just restates
itself, like `weight: 80.5`.

Two guardrails: a property whose (sanitized — spaces and punctuation become `_`) name collides with
an existing Numbat name, a unit like `m` or `hours`, a function, a dimension, or a variable like
`pi`, is **skipped with an error** rather than shadowing it, since e.g. binding `m` would quietly
change what `5 m` means everywhere; and a botched expression simply fails its own binding (shown at
the property) without breaking the properties after it.

A `numbat-use` frontmatter property provides **cross-note imports** where naming other notes as
links (`numbat-use: "[[Constants]]"`, or a list) imports those notes into this one's scope: each
named note's `numbat-shared` blocks and its Numbat-typed properties become available here, replayed
**before** this note's own properties. So a shared `[[Constants]]` note can define `numbat-shared`
functions and typed properties (`g`, `c`, a `tax_rate`) that every note using it can reference.

Links are followed **transitively** (a used note's own `numbat-use` chains in), with a cycle guard,
and an imported note's _untyped_ numbers and plain `numbat` blocks stay private to it. Nested typed
properties export like any other (a used note's `rates.vat` arrives as `rates.vat`); `numbat-use`
itself is read at the top level only. Edits to an imported note re-evaluate the notes that use it.
One broken import is contained, and does not sink the others.

All three behaviors live under the **Note properties** settings section: a master toggle, the
plain-numbers sub-toggle, and the imports sub-toggle.

## Note Scope Inspector

A right-sidebar panel, opened from the ribbon (the list icon) or the **Symbat: Open note scope
inspector** command, that shows, as a collapsible tree, every binding the active note has in scope:

- The definitions in your own `.nbt` **user prelude** files (one group per file, in the order they
  load), so you can see what your custom units, constants, and functions resolve to. It sits at the
  top: it is the foundation everything below is layered on.
- The bindings pulled in by **imported** `numbat-use`, grouped under each source note.
- The note's Numbat-typed and plain-number **frontmatter properties**, plus a **Skipped** group
  listing any property that did not bind and why (a reserved name, a duplicate, …).
- The declarations in each **`numbat` / `numbat-shared` block**, labeled with the block's line range
  (`Shared block (L5-9)`). A plain `numbat` block is tagged **local**, a reminder that it runs but
  does not export into the note's scope.
- Any **inline** `` n`let …` `` spans written in prose.

Each source lists every declaration (`let`, `unit`, `fn`, and `dimension`) the way it reads in the
editor: a `let` by name, a `unit` and a `dimension` as their declaration (`unit U`, `dimension D`,
keyword-colored), and a `fn` followed by its type signature (`f : Fn[(Length) -> Length]`, the same
form the completer shows). A `let` or `unit` also shows its evaluated value; an incomplete one shows
its `⟨Type⟩`, a broken one its error, and a binding that a later one shadows is dimmed.

You can click a binding to jump to its definition (an imported or prelude one opens its file). The
tree tracks the active note and updates as you edit.

Wherever your cursor is, the inspector highlights it: the node the caret is in, and, when that node
is open, the row for the declaration the caret is actually on. That happens as you move, always. A
pinned row of controls at the top expands or collapses everything, and the **Reveal active line**
toggle additionally keeps the caret's node expanded and scrolled into view; turn it off to keep the
highlight but stop the tree from opening and moving under you.

### Scope Search

A search box is pinned at the bottom of the panel (**Symbat: Search the note scope and prelude**
focuses it). It searches everything the tree shows (including the properties that were _skipped_, so
looking up a name that isn't working finds the reason). It also searches **Numbat's own bundled
prelude**, which is otherwise not listed anywhere: the interpreter exposes its standard library as a
flat list of names, so searching it is how you browse it.

Results appear above the box, ranked best match first and styled like the editor's completer: the
name with the matched characters highlighted, its type signature, its kind, and where it came from
(`prelude` for a bundled one). Arrow keys — or `Ctrl-N` / `Ctrl-P` — walk the results, and each one
opens its node in the tree above and highlights its row, so you can see _where_ a binding lives
without going anywhere. Press `Enter` to actually jump to it. `Esc` clears the search and puts the
tree back exactly as you had it.

Rest on a result for a moment and its documentation opens: Numbat's own reference for a bundled or
prelude item, and for one of the note's own bindings a card giving its source, definition, value,
and type.

## Numbat File Editor Support (`.nbt`)

A standalone `.nbt` file opens in its own editor inside Obsidian, and is treated as the Numbat
program that it is, evaluated top to bottom.

Registering the extension is also what makes those files **visible**, as Obsidian hides any
extension that no plugin claims. This means that a personal prelude module did not appear in the
file explorer or the quick switcher at all, and go-to-definition into one had nowhere to land.

The editor is the same one used by the REPL input, so everything you already have applies: syntax
highlighting, expression completion with signatures and documentation, hover cards, `\code` → glyph
expansion, and each line's result and each binding's inferred type, shown inline exactly as in a
`numbat` code block.

Find and replace is built in (bound to `Ctrl-F`), since Obsidian's own search is bound to the
Markdown editor and is not available here. Vim key bindings and the line-number gutter follow
Obsidian's own **Vim key bindings** and **Show line number** editor settings, so a Numbat file looks
and behaves like every other editor in the app (with the exception of supporting custom vimrc
configurations).

There are no new settings: everything above is governed by the toggles it already had.

**Creating one.** Obsidian's "New note" only ever makes Markdown, so use the command **Symbat:
Create a `.nbt` file**, or **New Numbat file** from a folder's context menu in the file explorer.

A Numbat file's **scope** is its own text, over the prelude files loaded _before_ it. That is
precisely what the file sees when your prelude loads, and it matters: because every interpreter
context already loads your whole prelude, evaluating a prelude file naively would define everything
in it twice. As a repeated `unit` or `dimension` is an error, this avoids every result below the
first becoming a diagnostic instead of a value.

**When it is part of your prelude**, a banner appears above the editor if the prelude loaded ahead
of it failed, or if this file itself will not load. A broken prelude is otherwise an invisible
failure: it simply stops applying, everywhere in the vault at once, with no error shown anywhere.

The [note scope inspector](#note-scope-inspector) follows a Numbat file too, listing its
declarations with their values alongside the prelude files ahead of it.

## REPL Font Sizes

By default the REPL follows the theme's code size. Enable **Custom font size** in the settings to
set the output ("view") and input font sizes independently; each accepts any CSS size, such as
`14px`, `0.9em`, or `var(--code-size)`.

## Unicode Expansion

Typing a LaTeX-style code such as `\alpha` replaces it with the corresponding Unicode character
(`α`) the moment the code is complete in any location you write Numbat, using the same `\`-codes
Numbat's own REPL supports.

Expansion happens as you type: when a completed code is recognized it replaces the text; when it is
not, your keystroke is left untouched, so it composes with other editors and text-expansion plugins
(Numbat takes precedence for the codes it knows, and defers everything else). Turn it off with the
**Unicode expansion** setting.

As you type the leader, a completion popover (Obsidian's native completer in blocks, and the same
popover on the REPL input) lists the matching codes alongside their glyphs; choosing one inserts the
glyph. It is handy for discovering a code or picking a longer one without typing it out. The popover
and the eager expansion work together — the popover helps while a code is still partial, and eager
expansion finishes a code the moment you complete it — and both follow the **Unicode expansion**
setting. The leader defaults to `\` and can be changed with the **Unicode leader** setting.

## Vim Mode

The REPL input and the `.nbt` file editor both support editing using Vim mode. The editor inherits
the setting directly from Obsidian's editor settings, while the **Vim mode** setting (under
**Editor**) controls the REPL input. It defaults to **Match Obsidian**, so the REPL follows your
editor's "Vim key bindings" setting automatically; set it to **On** or **Off** to override.

In all cases it provides standard Vim — normal/insert/visual modes, motions, operators, and `:`
commands — but not your personal `vimrc` mappings, which still apply in `numbat` code blocks. The
`:`/`/` command line opens in place of the input, with the prompt reading `e >`. On mobile, an
**Esc** button appears to the left of the prompt while the on-screen keyboard is up (which has no
Esc key), to make it possible to leave insert mode.
