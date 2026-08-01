# Roadmap

This document exists to explain where this project aims to go, and what it is deliberately leaving
out. Nothing here is committed to or has a date, but is intended as a statement of intent. Large
items have a design note of their own.

## Near Term

The following are near-term goals that are relatively small.

- **Community Plugin Registry:** Symbat installs by hand today. Submitting it means meeting
  Obsidian's review checklist and, more consequentially, committing to a public support surface.
- **Real-Vault Coverage of the Settings Tab:** The settings path is exercised by type-checking and a
  golden descriptor test, not by anything that renders it. Every settings change needs a manual pass
  until that is no longer true.
- **A Per-Note Result Cache for the Property Widget:** The Numbat property field builds a fresh
  interpreter context on every evaluation, and ignores the default-decimal-places setting that
  inline evaluation honors. Both are small, but both are visible.

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
  object requires [Better Properties](https://github.com/unxok/better-properties), which is the only
  way to reach a nested property's type menu.
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
