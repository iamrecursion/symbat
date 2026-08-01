# Design Note: Graphing

**Status:** Not Started

## The shape

A fenced block of its own — `numbat-plot` — naming a function and domains.

A block rather than a command or a modal, because it's important that **the note's scope is what the
plot draws on**: a function already defined in a `numbat-shared` block, imported from another note
via `numbat-use`, or living in your personal prelude should be plottable without restating it. The
plugin already replays exactly that scope for completion, hover, and inline evaluation
([scope replay](../architecture.md#scope-replay)); a plot is one more consumer of it.

## What Numbat Brings that a General-Purpose Grapher Cannot

[LMath](https://github.com/lubriedev/lmath) is the reference point for how good this can feel. It
declares plots as code blocks (`obs-graph`, `obs-system`, `obs-derivate`, `obs-integral`), handles
explicit, implicit, parametric, and polar curves, and is properly interactive — drag to pan, wheel
to zoom about the cursor, a crosshair reading out coordinates, and a "rail" mode that walks along a
curve by arc length and steps across asymptotes. It traces curves by arc length rather than sampling
per pixel, and labels the notable points it finds: roots, vertices, intercepts, asymptotes. All of
that is worth stealing.

Underneath, LMath is [mathjs](https://mathjs.org) — its only runtime dependency — plus a hand-rolled
WebGL renderer. Mathjs is precisely the layer Numbat would replace here, and swapping it cuts both
ways. That is what makes this interesting rather than a straight port.

### What Numbat Improves: Units, Checked by the Type System

Mathjs has units, but as runtime values, and LMath's graphing does not surface them at all. With
Numbat:

- a domain would be **written with units** — `x: 0 m to 10 m`;
- the axes would **carry the dimensions** Numbat infers for each side;
- a plot whose axes disagreed dimensionally would be a **type error**, not a silently wrong picture.

That is the same guarantee the rest of the plugin gives, and plotting a function straight out of the
note's scope — already unit-correct — is the feature no general-purpose grapher can offer.

### What Numbat lacks: symbolic algebra

Mathjs parses to a manipulable expression tree and can differentiate and simplify it. Numbat
evaluates; it has no equivalent, for the reasons in the [CAS note](cas.md).

Two of LMath's four block types lean on that. `obs-derivate` is symbolic differentiation outright,
and its auto-simplification, auto-solving for `y`, implicit curves, and analytic asymptote detection
all rest on tree rewriting. Mirroring them would mean numeric methods — finite differences,
quadrature, root-finding on sign changes — or leaving them out.

**Explicit, parametric, and polar curves need none of it**, so that is where to start. The rest
waits on the CAS, which is why these two design notes are ordered the way they are.

## Questions Before Prototyping

### Building on Existing Tools?

There are a few Rust symbolic computation systems such as
[symbolica](https://github.com/symbolica-dev/symbolica) and
[oCAS](https://github.com/charleshzh/ocas). It is both unclear whether they could be sufficiently
wired together with a forked Numbat (or even compiled for WASM) is an open question, though if so we
can avoid reinventing the wheel.

### Rendering: SVG or WebGPU?

LMath uses WebGL. This plugin has **no runtime dependencies** and a bundle already dominated by the
interpreter, so hand-rolled SVG is the likelier fit — and it is also the one that themes correctly
with Obsidian's CSS variables for free, the way the rest of the plugin's output already does.

The counter-argument is interactivity: pan-and-zoom at 60fps over a densely traced curve is where
WebGPU would become really valuable. Which side that lands on depends entirely on performance, which
is why that gets measured first.
