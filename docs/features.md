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
- **Complete types** includes built-in and struct types (`Bool`, `String`, `Opt`, struct, …).

Typing `@` at the start of a statement offers Numbat's **decorators** — `@name`, `@description`,
`@url`, `@example`, `@aliases`, `@metric_prefixes`, `@binary_prefixes` and `@abbreviation` — from
the first character, since the set is small and closed. Accepting one writes the punctuation its
grammar requires and leaves the caret where the argument goes (`@name("‸")`). They are gated by
**Complete keywords**, being syntax rather than names, and each carries a one-line description in
the documentation popup and on hover. Both only where a statement can be written — a code block, the
REPL, or a `.nbt` file; an inline evaluation and a frontmatter value each hold a single expression,
which gives a decorator nothing to annotate, so neither completes nor describes one there.

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

In a **value** position the same declaration offers what it binds there instead: its **parameters**,
and the **locals** of its `where`/`and` clauses.

Inside `fn price_level(local_price: Money, bench_price: Money) -> Scalar = r where r = …`, typing
`loc` offers `local_price` tagged **parameter** with `Money` as its signature, and `r` is offered as
a **local**. They are gated by the **Complete identifiers** setting, prefix-filtered like everything
else, and drop out of the list once the declaration ends. A struct's fields are not offered this
way: those are reached through a value of the struct (`costs.`), never bare.

Because no context knows these names, neither their signature nor their documentation is asked of
the interpreter as an outer binding that happened to share the name would answer in their place.
Both come from the declaration itself, which is also where the hover card for one comes from.

The `<` trigger recognizes a capitalized name touching its `<` (`List<`), so a spaced comparison
(`a < b`) never opens it. The unicode and history leaders take precedence, so typing a `\code` or a
`?:` history query never triggers expression completion.

Navigate the popover with the arrow keys, emacs-style Ctrl-N / Ctrl-P, or Tab to accept. In a
[`.nbt` file](#numbat-file-editor-support-nbt), where Tab is also the indent key, an open popover
takes precedence, so tab only indents once it has closed. The first completion after the plugin
loads shows a brief “Loading Numbat…” placeholder while the interpreter initializes. None of this
runs, and no code is replayed, unless **Expression completion** is enabled and so you can turn the
whole feature off with that setting.

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
- A **parameter**, a **type parameter**, a **`where`/`and` local**, or a **field in a `struct`
  declaration** exists only inside the declaration that introduces it, where no context has ever
  heard of it. Its card is what the declaration says: the kind, the declared type, and which `fn` or
  `struct` it belongs to, found from the body as well as the signature. It is the same card the
  completer shows for the same name.

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

So is a **function definition laid out over several lines**, which needs no brackets at all. Numbat
reads on past a definition's `=` and around a `where`, an `and`, a `then` and an `else`, and the
hints follow it — a `fn … = r` and the `where r = …` beneath it are one statement, as are a body
written on the line below its `=` and a multi-line `if`/`then`/`else`. Blank lines and comments
between the halves are stepped over. Split apart they would be a different program: the body alone
reports its `where` names as unknown identifiers, and the clause alone does not parse.

One consequence is worth knowing: since a trailing `=` reads on, an unfinished `let x =` with any
statement below it takes that statement as its value, rather than showing the missing-operand
placeholder. That is what the rendered block does with it too.

**Decorators** belong to the declaration below them, so they are read together with it — a
`@description("…")` on its own line is not evaluated alone and is never flagged as an error. Any
number of them may stack, with blank lines and comments between, and the declaration's own hints
still anchor on the declaration's line rather than on the annotations above it. The annotations
themselves take effect: a `@description` or `@aliases` you write shows up wherever that name is
later completed, hovered, or listed.

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
blocks. Keywords, numbers, strings, operators and comments all take their theme color, so an
expression reads the same in the REPL as it would in a block. A **decorator** takes the theme's tag
color, distinct from units — only the `@name` itself, with its parentheses and string argument
keeping their own colors. Override it with `--numbat-decorator` (as `--numbat-unit` and
`--numbat-dimension` override theirs). Ordinary names take the theme's own code color
(`--code-normal`) rather than its prose color, so they sit with the rest of the tokens.

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
- **Plain Values:** A property without the Numbat type still binds the value it holds — a number
  (`hours: 3`) as a dimensionless scalar, text as a Numbat `String`, a date as a `DateTime`, a
  checkbox as a `Bool`. Each kind is its own toggle, since they differ in how much of a note's
  frontmatter they put into its namespace: numbers are almost always arithmetic, text almost always
  prose.

Plain values follow a few rules worth knowing:

- **Text is escaped**, so nothing in a note's prose can be read as Numbat. That matters most for `{`
  as Numbat strings interpolate, so an unescaped `cost {rate} each` would _evaluate_ `rate`.
- **A date needs a date type**, assigned in the property's type menu — Obsidian's Date or Datetime,
  or this plugin's [Zoned Date or Zoned Datetime](#time-zones-on-dates). Obsidian shows its date
  picker for anything date-shaped without assigning a type, so the shape alone is not the opt-in it
  looks like — and a version, an ID or a bare year would otherwise read as a moment on the strength
  of looking like one. Without a type it is text, like any other prose.
- **Every date binds with an explicit time zone.** An offset written in the value is used exactly as
  written; a value without one is read in the zone set by **Time zone for dates**, which defaults to
  your own. A date with no time of day is that zone's midnight, so `due - today() -> days` means
  what you would expect. See [Time Zones on Dates](#time-zones-on-dates) for how to write an offset
  and what it costs to leave one out.
- **An unticked checkbox is `false`**, which subtly disagrees with Obsidian's Checkbox type which
  has three states, and the unset one is written as an empty property. This reading applies only to
  a property the type menu says is a checkbox or a toggle.
- **`tags`, `aliases`, `cssclasses` and `numbat-use` are omitted** as they are vault machinery
  rather than note data, and they are on a great many notes. Assigning one the Numbat type binds it
  anyway, and the names are only special at the top level — a `meta.tags` of your own is your data.

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

Numbat lists hold one type, so a **Numbat-typed** mixed list (`[1, "a"]`) binds and reports Numbat's
own type error on the property. An **untyped** one instead stays quiet as it was never opted in. Its
items still bind when they are all the same kind, under the plain-value rules above.

A list's items share one **property key**, written `<key>.#`. This is a name in _Obsidian's_
property registry, not a Numbat one — `#` is not Numbat syntax, and an array item has no Numbat name
at all (the list binds under the array's own key, and you reach an item with `element_at`). It is
[Better Properties](https://github.com/unxok/better-properties)' spelling for the sub-property every
item of an **Array** type shares, which is why one type assignment covers all of them, and it is
where Symbat reads that assignment from, at any depth: `rates.#`, `costs.items.#`, a nested array's
`grid.#.#`. A type assigned to the array's own key works too, and is how a list binds with no extra
plugin.

The distinction matters because the two kinds of dotted name look alike. `costs.total` is _both_ a
property key and a Numbat field path, so it reads the same in the frontmatter and in a code block.
`rates.#` is only ever the former.

An **array of objects** binds as a list of Numbat structs, with one type shared by every item, which
is what an Array property already promises:

```yaml
legs:                        # the property keys `legs.#.distance` and `legs.#.time` carry the type
  - distance: 5 km
    time: 21 min
  - distance: 10 km
    time: 46 min
```

`legs` is then a two-element list: `len(legs)` is 2, `element_at(0, legs).distance` is `5 km`, and a
`fn` written over the element type maps across the whole of it. Note the difference between the two
columns above — `legs.#.distance` is what you assign the type to in the properties panel, while
`element_at(0, legs).distance` is what you write in Numbat to read it.

The items must agree on what each field _holds_; a field one of them leaves out or writes empty is
[undefined](#properties-with-no-value) there rather than a disagreement. An array whose items cannot
be reconciled binds nothing and says so on the array. Items whose fields disagree _dimensionally_ (a
`5 km` beside a `10 s`) do bind, and Numbat reports its own type error on the property: the same
guarantee the rest of the plugin gives.

Two things to know about arrays:

- An item has **no line of its own** to anchor a result on, and a list written as a block shows no
  result on its key line either — the items are right there to read. An **error** or an incomplete
  `⟨Type⟩` still shows there, since that is the only warning you would get. A list written on its
  key line (`rates: [5 EUR, 3 EUR]`) shows its `= [5 €, 3 €]` as any other value does, and the note
  scope inspector always shows the whole list. In Source mode the completer, hover and auto-pairing
  treat an item's text as the Numbat code it is.
- An item **cannot reference its siblings** the way an object's properties can: there is no name for
  an index. Items see the note's imports and the properties written above the array, as any property
  does.

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
- A YAML **list** inside an object is one field holding the whole list, not a property per item — no
  struct field can name an index. See [above](#note-properties) for how its items are typed.

### Properties with No Value

A property written with nothing after it — a blank item in a list, a field one entry of an array
leaves out — binds as **`nil`** rather than taking the structure around it down with it. So a list
of weights with one gap is still a list of weights:

```yaml
weights: [70, , 72]     # a three-element list, with a hole in the middle
legs:
  - distance: 5 km
    pace: 5 min / 1 km
  - distance: 10 km     # no pace written: `pace` is nil here, and `legs` still binds
```

The value shows as `nil`, which is faint since it is the absence of data rather than data, and
overridable with `--numbat-undefined` if you would rather a hole stood out than receded. Its type is
`Opt<T>`, so `weights` above is a `List<Opt<Scalar>>` — a type you can write yourself, in a `fn`
signature or a `let` annotation, exactly as it is shown to you.

Five functions read an `Opt`:

- `get_or(x, fallback)`: The value, or `fallback` when there is none. The one to reach for.
- `get_or_else(x, f)`: The same, but calling `f` only when there is nothing to return, so an
  expensive or failing fallback is safe to write. Numbat has no anonymous functions, so `f` is the
  name of a `fn` that takes no arguments.
- `is_defined(x)` / `is_undefined(x)`: Whether there is a value.
- `get(x)`: The value, and a **runtime error** when there is none. Prefer `get_or`.

And two write one, so a hole is something you can hand to your own functions rather than only
receive: `some(x)` holds a value, and `nil` holds none. `nil` needs no type argument and no
parentheses. It serves as an absent length in one line and an absent scalar in the next. If you
would rather say the long word, **`undefined`** is the same value under another name.

Each of these describes itself: hover one, or dwell on it in the completer, for a card saying what
it does. So does `Opt`, and every other type name (`List`, `Bool`, `String`, `Fn`, `DateTime`),
which Numbat itself documents nowhere. `Opt` completes like any other type too, including at a type
position such as `let x:` or `List<`.

`get_or(element_at(1, weights), 0)` and `is_defined(element_at(1, legs).pace)` read like any other
expression: the hole is a value you can work with rather than a lost binding.

Five limits worth knowing:

- A property with **no type assigned and no value** still binds nothing. An empty property is on a
  great many notes, and every one of them claiming a Numbat name to say `nil` would be worse than
  the gap it fills. Assign it the Numbat type, or any type that binds, and it binds.
- An empty **Numbat-typed** property _inside an object_ binds nothing, where the same property at
  the top level binds fine. The Numbat type says what a value is written in, not what it is, so an
  empty one leaves its type unknown — and a field of unknown type makes _every_ field of that object
  unreadable, not just the empty one. It is left out instead, and says so on the property, the same
  answer an array gives a field no item fills. Write any value and the field appears. An empty
  **number**, **text**, **date** or **datetime** property is unaffected wherever it sits: those name
  the type outright, so the hole keeps its place and reads back as an `Opt` of that type.
- A field **nothing ever says anything about** is dropped from the object or the array element type
  rather than binding a column of `nil`. That is a field no entry fills, and equally one every entry
  writes as an empty list (`[]`) or as a list of nothing but gaps: emptiness does not say what would
  have been there, and the field would cost its siblings their readability for a hole you can
  already see in the frontmatter.
- A genuinely **mixed** list (`[1, "a"]`) is unchanged: a gap is not a disagreement, and a
  disagreement is still not a Numbat list.
- A value the plain-value settings above exclude is a **non-participant**, not `nil`; turning it
  into one would put back exactly what the setting keeps out. An unset **checkbox** is still
  `false`.

`nil`, `undefined`, `some`, `get`, `get_or`, `get_or_else`, `is_defined` and `is_undefined` are
Numbat names like any other, so a property named after one is skipped by the collision guard below.
`Opt` is not: it is a type name, and a property may be called that freely.

Assigning the Numbat type to a nested property, or to an array's items, needs the
[Better Properties](https://github.com/unxok/better-properties) plugin, which is the only way to
reach the type menu of a sub-property. Nested **plain values**, however, work with no extra plugin,
as does a type assigned to a top-level list's own key.

Every binding is then in scope for **everything in the note** — plain `numbat` blocks,
`numbat-shared` blocks, inline `` n`…` `` expressions, and their completions: a note with
`distance: 21.1 km` (typed Numbat) can write `` n`distance -> mi` `` in prose or use `distance` in
any block. Bindings apply in **frontmatter order**, before everything else in the note, so a later
property can reference an earlier one, and a property expression never sees the note's blocks, only
the properties above it.

When you edit the frontmatter as raw YAML in **Source mode**, each bound property shows the same
muted `= value` (or `⟨Type⟩` / error) at the end of its line that a `numbat` block line does, so you
get the result without leaving the text. In Live Preview and reading view the property widget shows
it instead. This follows the inlay-hint settings, and a result is suppressed when it would only
repeat what the text already says: a value that restates itself, like `weight: 80.5`, and a value
written on the lines _below_ its key, like a block list. An error or an incomplete `⟨Type⟩` is never
suppressed.

Two guardrails: a property whose (sanitized — spaces and punctuation become `_`) name collides with
an existing Numbat name, a unit like `m` or `hours`, a function, a dimension, or a variable like
`pi`, is **skipped with an error** rather than shadowing it, since e.g. binding `m` would quietly
change what `5 m` means everywhere; and a botched expression simply fails its own binding (shown at
the property) without breaking the properties after it. The one exception is _within a single
object_: each of its leaves rebuilds the object from the one before, so a leaf that fails leaves the
object frozen at the fields bound above it, and the leaves below it cannot be reached through the
object until it is fixed. Properties outside that object are unaffected.

A `numbat-use` frontmatter property provides **cross-note imports** where naming other notes as
links (`numbat-use: "[[Constants]]"`, or a list) imports those notes into this one's scope: each
named note's `numbat-shared` blocks and its Numbat-typed properties become available here, replayed
**before** this note's own properties. So a shared `[[Constants]]` note can define `numbat-shared`
functions and typed properties (`g`, `c`, a `tax_rate`) that every note using it can reference.

Links are followed **transitively** (a used note's own `numbat-use` chains in), with a cycle guard,
and an imported note's _untyped_ plain values and plain `numbat` blocks stay private to it. Nested
typed properties export like any other (a used note's `rates.vat` arrives as `rates.vat`);
`numbat-use` itself is read at the top level only. Edits to an imported note re-evaluate the notes
that use it. One broken import is contained, and does not sink the others.

Both rules — the sub-toggles for plain values, and "untyped values stay private" on export — are
about _top-level_ properties, so an **object binds whole**. Once anything under it is wanted, its
plain leaves come along as fields, because they are part of the value rather than bindings of their
own — and a leaf may well read one (`Current Year` is a plain number, `Year Delta` is the Numbat
expression `(world.Current_Year - …)`). Withholding a field there would withhold no name; it would
hand back a different object than the one that was written, and break every sibling reading it.

What "wanted" means is whatever the top level would have bound: in the note itself, a leaf that is
Numbat-typed or of a plain kind you left switched on; on export, a Numbat-typed leaf only. So an
object of nothing but text still stays out of a namespace that binds no text, ordinary metadata is
still not exported, and an object that binds at all binds the shape you wrote. The same holds for an
array — it binds when a wanted leaf sits inside it, item types included (`legs.#.distance`).

All three behaviors live under the **Note properties** settings section: a master toggle, one
sub-toggle per kind of plain value (numbers, text, dates, checkboxes), and the imports sub-toggle.

### Properties in Bases

A Numbat property needs nothing extra to appear in a **Base**: Obsidian draws a table or card cell
with the same widget the properties panel uses, so the column evaluates per row, against that note's
own properties and imports.

A cell is a box in a grid rather than a line of its own, though, so there the widget reads as a
value rather than as an editor:

- **A cell shows the result**, on its own (no expression, no leading `=`) at the weight of every
  other column, keeping the colors Numbat gives a value. An expression that fails shows its error
  instead. A value too wide for the column runs off the end and fades out, rather than wrapping to a
  second line the row has no room for.
- **Clicking a cell opens the expression**, with its `= value` beside it exactly as in the
  properties panel: completion, hover cards and Unicode expansion all work there. Clicking away, or
  pressing Enter, commits and gives the cell back to its value.
- **The property panel is unchanged**, and so is the Properties sidebar, and so is a hover popover.
  Those have a line each, and keep the editor they have always had.

The [Zoned Date and Zoned Datetime](#time-zones-on-dates) types behave the same way, showing
`2026-07-27 10:30 Europe/Berlin` until the cell is clicked into and the picker appears.

An empty column is worth one note: a cell shows the property's **expression** whenever there is no
result to show yet — while the interpreter is still starting up, or with **Note properties** turned
off — so a column is never blank when the notes underneath it are not.

## Note Scope Inspector

A right-sidebar panel, opened from the ribbon (the list icon) or the **Symbat: Open note scope
inspector** command, that shows, as a collapsible tree, every binding the active note has in scope:

- The definitions in your own `.nbt` **user prelude** files (one group per file, in the order they
  load), so you can see what your custom units, constants, and functions resolve to. It sits at the
  top: it is the foundation everything below is layered on.
- The bindings pulled in by **imported** `numbat-use`, grouped under each source note — an imported
  object property nested under its own name, one row per leaf, the way the note's own frontmatter
  objects read. An imported binding whose code failed to run shows that error, rather than sitting
  there blank.
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

**Tab indents.** In a `.nbt` file — a whole program, not a one-line expression — `Tab` inserts an
indent rather than moving focus out of the editor. It aligns to the next multiple of the configured
width, so pressing it at column 3 with a width of 2 lands on column 4, and `Shift-Tab` steps back to
the previous multiple. With a selection, both apply to every line it spans.

The completer still owns the key: while the completion popup is open, `Tab` accepts the selected
completion exactly as it does everywhere else, and only indents once the popup has closed. To move
focus out of the editor with the keyboard, press `Esc` and then `Tab` (or toggle tab-focus mode with
`Ctrl-M`).

The one new setting is **Editor → Tab indent width** (default 2). Everything else above is governed
by the toggles it already had.

**On mobile, a key bar** appears at the bottom of the editor whenever the on-screen keyboard is up,
carrying the keys that keyboard does not have:

| Button |                                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `⎋`    | **Escape** — leaves insert mode, leaves visual mode, and cancels a half-typed operator or count. Without it, a phone keyboard offers no way out of insert mode at all.                                           |
| `▦`    | **Visual block** — starts blockwise visual selection, and ends it when pressed again (`Ctrl-V` on a hardware keyboard). It stays lit while that mode is live, so you can always see which way the toggle is set. |
| `⌄`    | **Hide keyboard** — dismisses the keyboard without having to tap somewhere else in the app.                                                                                                                      |

The first two appear only when Vim key bindings are on; hiding the keyboard is useful either way, so
the bar still shows for it alone. The whole bar is gone when the keyboard is down — including when
you pair a hardware keyboard, which has all three keys already.

The buttons float over the file rather than sitting on a toolbar, so the text runs on behind them
and only the buttons themselves take a tap — tapping between them places the caret on the line
underneath as it would anywhere else. The document gains their height as extra scrolling room while
they are up, and the caret keeps clear of them, so the end of the file is never stuck under a
button.

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

## Time Zones on Dates

A frontmatter date means a different instant depending on where it is read, and Obsidian gives you
no way to say which one you meant. Its Date type holds `2026-07-27` and nothing else, giving you a
date anchored only to your current timezone. Obsidian's Datetime type _can_ hold an offset, but
offers no way to set one and discards any you write by hand the moment you touch the widget. Since a
date binds into Numbat as a `DateTime`, that ambiguity becomes very visible.

Three things address it, and you can use any of them on their own.

**A vault-wide default.** **Time zone for dates** sets the zone a value with no offset of its own is
read in — an IANA name such as `Europe/Berlin`, a literal offset such as `+02:00`, or blank for your
own zone. A named zone follows daylight saving, so a date in January and one in July are each read
at the offset that zone actually had, rather than at one snapshot of it.

The Symbat-provided **Zoned Date and Zoned Datetime** property types provide a fix to this. You can
assign either from a property's type menu and doing so will allow its values to gain a zone.

```yaml
due:  2026-07-27                                 # read in the default zone above
due:  2026-07-27 +02:00                          # pinned: two hours ahead of UTC, forever
due:  2026-07-27 [Europe/Berlin]                 # floating: whatever Berlin was on that day

when: 2026-07-27T10:30                           # the default zone again
when: 2026-07-27T10:30Z                          # pinned to UTC, written the short way
when: 2026-07-27T10:30+02:00                     # pinned to an offset
when: 2026-07-27T10:30:00+02:00[Europe/Berlin]   # floating, and lexically sortable
```

A **date** keeps a space in front of its zone, where a datetime does not. `2026-07-27-07:00` reads
as four dash-separated numbers and you have to count digits to find where the date stops;
`2026-07-27 -07:00` does not. After a clock there is no such confusion, and no room for a space
either — that form is real ISO 8601 and other software reads it. A date written the old way still
reads as itself, and is simply re-spelled the next time the widget writes it.

A few spellings are accepted on the way in and tidied up when the widget next writes: a space
instead of the `T`, an offset without its colon (`+0200`), and fractional seconds. **`Z` is not one
of them** — it is kept as written, because rewriting it to `+00:00` would be the widget editing your
text for no reason. The picker offers `Z (UTC)` and `+00:00` as separate entries for that reason,
alongside `UTC` itself, which is a zone _name_ and so writes the floating `+00:00[UTC]`.

The difference matters. **An offset pins an instant**: `+02:00` stays `+02:00` even if you later
move the date into November, when Berlin is on `+01:00`. **A name floats**: move the date and the
instant moves with it, because the zone is re-read for whichever day the value now names. Pick a
zone by name from the picker and you get the floating form; pick a bare offset and you get the
pinned one.

The named form is [RFC 9557](https://www.rfc-editor.org/rfc/rfc9557.html) — the standard for
attaching a zone to a timestamp, and what JavaScript's `Temporal.ZonedDateTime` round-trips. On a
datetime it is the full extended form, with the offset in front, so values still **sort lexically**
and their prefix is a valid RFC 3339 timestamp. On a date there is no time to write and adding one
would change what the value is, so it is the bare `2026-07-27 [Europe/Berlin]` — which still sorts,
the date being the prefix.

The widget is Obsidian's own date or datetime picker with a zone field beside it, and a value
**stays bare** unless you choose a zone — nothing is added to one you have not zoned. Both live
under types of ours rather than Obsidian's, deliberately: neither spelling is a YAML timestamp, and
nothing that parses dates today reads RFC 9557, so under Obsidian's own types they would be broken
dates to Bases, to sorting, and to every other plugin.

In a **Base** cell the same widget shows the value as text — `2026-07-27 10:30 Europe/Berlin`, with
none of the punctuation the written form needs — and produces the picker and the zone field, side by
side on one line, only once the cell is clicked into. See
[Properties in Bases](#properties-in-bases).

The zone field **searches as you type**. Leave it empty and it offers the short list — your own
zone, `UTC`, and the offsets in real-world use — so the common choices are still one click away.
Type anything and it searches every zone your platform knows, so `berlin` finds `Europe/Berlin`
without scrolling a menu of six hundred entries. Nothing is written until you pick something: text
you type and then abandon leaves the value alone.

A zoned value is also **read back in its own zone**. Numbat shows every moment in the zone of the
machine it is running on, so a 9am meeting written in Los Angeles would otherwise read back as 6pm
in Berlin — the same instant, correctly converted, and not the thing the note is about. A value that
carries a zone is shown at the clock it was written at, and the zone is named beside it.

A value written at a whole-hour offset is named the way the timezone database names those, so
`-05:00` reads back as `Etc/GMT+5`. **The sign is inverted, and that is not a mistake**: `Etc/GMT+5`
_is_ UTC−05:00, a rule POSIX set and the database has kept ever since. Offsets that are not whole
hours — `+05:45`, `-03:30` — have no such name, so those values keep their instant but are shown in
your own zone. Choosing the zone by name rather than by offset avoids that, and says more besides.

The row **wraps** when it has to: a property row is narrow, and a picker plus a zone name will not
fit on one line on a phone, so the field drops below rather than squeezing the picker to nothing.

**Obsidian's own date types are left alone.** Symbat adds two types and patches none, so its Date
and Datetime widgets behave exactly as they do without this plugin installed. A value written under
one of those still binds — an offset written by hand into a datetime is read and shown in the zone
it names — but Obsidian's widget will still drop that offset the next time it writes the property,
which is the whole reason the Zoned types exist.

An earlier version did add a zone field to the built-in Datetime widget, behind a setting. It has
been **removed**: replacing one of Obsidian's widgets inherits every change Obsidian later makes to
it, where owning a type of our own does not, and `Zoned Datetime` covers the same ground. A value
you wrote under that setting is a perfectly ordinary zoned timestamp and keeps working; assign it
the **Zoned Datetime** type to get the zone field back.

In both types, choosing a zone **reinterprets** the value rather than converting it: the clock stays
where it is and only what is written beside it changes, because the job is to say what an
already-written date meant.

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
Esc key), to make it possible to leave insert mode. The `.nbt` editor gets a whole key bar for the
same reason — Escape, a visual-block toggle, and hide-keyboard — described under
[Numbat File Editor Support](#numbat-file-editor-support-nbt).
