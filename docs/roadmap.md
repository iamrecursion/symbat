# Roadmap

This document exists to explain where this project aims to go, and what it is deliberately leaving
out. Nothing here is committed to or has a date, but is intended as a statement of intent. Large
items have a design note of their own.

## Near Term

The following are near-term goals that are relatively small.

- **Real-Vault Coverage of the Settings Tab:** The settings path is exercised by type-checking and a
  golden descriptor test, not by anything that renders it. Every settings change needs a manual pass
  until that is no longer true.
- **A Per-Note Result Cache for the Property Widget:** The Numbat property field builds a fresh
  interpreter context on every evaluation, and ignores the default-decimal-places setting that
  inline evaluation honors. Both are small, but both are visible.

## Better Numbers

Enhancing Numbat's numerical backend with a hierarchical number system that encompasses
arbitrary-precision integers, fixed-width integers, arbitrary-precision decimals, rationals, and
complex numbers.

## Sum Types

Currently Numbat only has `struct`, which declares a product type. It could be quite useful to be
able to compute with `enum`s (sum types) as well, especially if each arm is also a type in and of
itself

## Graphing

Plot a Numbat function over a set of ranges (in $n$ dimensions), as its own fenced block
(`numbat-plot`) naming a function and domains. A function already defined in a `numbat-shared`
block, an imported note, or your prelude can be plotted without restating it, and the note's scope
is what the plot draws on.

The interesting part here is not the rendering, but instead that **a Numbat plot could carry units
through the type system**: a domain written `x: 0 m to 10 m`, axes labeled with the dimensions
Numbat infers for each side, and a plot whose axes disagree dimensionally reported as a _type error_
rather than drawn as a silently wrong picture.

No general-purpose graphing library can offer that, and it is the same guarantee the rest of the
plugin already gives. See the [graphing design doc](./design/graphing.md) for why this is more than
a port of an existing plugin.

## Symbolic Computation

In the future we would like to support basic symbolic computation functionality, adding unit-aware
CAS functionality to Symbat. Do note that this is an explicit _non-goal_ of Numbat itself, so doing
so properly may incur a [soft fork](./design/soft-fork.md). Differentiation, integration,
simplification, solving, and arbitrary-precision arithmetic over values and symbols would be what
make the plugin comply with its namesake as **Sym**bat.

The main obstacle here is _access_ rather than _effort_. Numbat parses to a typed tree internally,
but its WASM boundary is stringly-typed so the plugin never gets an expression that it can
manipulate. The route, along with the argument for a close fork over a bolted-on JavaScript CAS, and
the honest cost of maintaining one are in the **[CAS design doc](./design/cas.md)**.

These two are ordered: graphing's explicit, parametric, and polar curves need no symbolic layer at
all, so that is where to start. Symbolic differentiation, auto-simplification, implicit curves, and
analytic asymptote detection all wait on CAS functionality.

## Known Limitations

The following are the sharper edges on using this plugin as it currently stands. Most of them share
one cause, which is that the WASM boundary hands over less than the interpreter computes (see the
[soft fork docs](./design/soft-fork.md) for some reasoning for opening it up).

- **Nested Properties are Janky:** Assigning the Numbat property type to a property inside a YAML
  object, or to the items of an array, requires
  [Better Properties](https://github.com/unxok/better-properties), which is the only way to reach a
  sub-property's type menu.
- **An Array Item has No Line of its Own:** Every item of an array shares one property key
  (`<key>.#`, Obsidian's name for it — not a Numbat one), which is what makes a list bind at all,
  but it means no item can carry its own inlay. A block list therefore shows only its errors in
  Source mode, and the whole list's value is read from the scope inspector, which lists the array as
  the one binding it is.
- **A Zoned Timestamp Inside a Flow Collection Still Reads Two Ways:** The quoting pass that
  protects a zoned timestamp from the YAML parser works one value site at a time, so it sees
  `dates: [2026-07-27T10:30:00+02:00]` as a single unparsed `[…]` scalar and leaves it alone. Read
  from the note's own YAML the offset is collapsed to an instant, where Obsidian's property cache
  keeps it as written — the two surfaces disagree, exactly as every zoned value used to. The block
  spelling (`- 2026-07-27T10:30:00+02:00`, one item per line) is a value site and is protected;
  prefer it, or quote the flow item by hand.
- **An Undefined Value is a One-Element List:** The `Opt` an empty property binds is
  `struct Opt<T> { value: List<T> }`, empty for `nil`, because Numbat evaluates eagerly and has no
  polymorphic bottom — there is no value to put in a `value: T` field when there is no value.
  Reading `x.value` rather than `get_or(x, …)` therefore shows a list. It is not `__Nullable` as
  once planned because Numbat reserves double-underscored type names; the short, writable name it
  has instead means a prelude of your own that declares `struct Opt<T> { value: List<T> }` would be
  read as this one.
- **The Bundled Prelude is Unstructured:** The WASM exposes the standard library as a flat list of
  names with no module structure or per-item origin. The sources _exist in the bundle_ but are not
  accessible.
- **User-Prelude `@aliases(...)` are Mislabeled:** The inspector search results mislabel these as
  bundled because we do not have enough information not to.

## Not Planned

The following are features that are explicitly considered out of scope for this plugin:

- **A `numbat()` Bases Formula Function:** This was designed and then dropped: a Numbat-typed
  property renders and evaluates natively inside a Base cell already, so the function would add a
  second way to do the same thing.
- **More Major Runtime Dependencies:** The bundle is already dominated by the interpreter. Features
  are built against the platform and Numbat itself, which is why the graphing note argues for
  hand-rolled SVG over a WebGL library.
- **Renaming the Language Artifacts:** The `` ```numbat `` fence, `.nbt`, `numbat-use`, the
  `numbat:expression` property type, and the `numbat-*` CSS classes all name Numbat, and Numbat is
  not this plugin. They stay as they are regardless of what the plugin is called.
