# Design Note: Symbolic Computation

**Status:** Not Started

The plugin is named for this: **sym**bat. Symbolic algebra is the one feature that would change what
the plugin _is_ rather than adding another surface to it, and it is also the one feature that cannot
be built with just the plugin alone.

## What it Would Be

It would encompass the core feature-set of a Computer Algebra System, including differentiation and
integration, simplification, solving of equations for variables, exact rather than floating-point
arithmetic, and so on. Concretely, inside a vault:

- A block that **simplifies** an expression rather than evaluating it;
- Exact derivatives, roots, and asymptotes for [graphing](graphing.md), instead of numeric
  approximations;
- A hover or an inline result that can show a **closed form** instead of a number.

## Why the Plugin Cannot Do It

Numbat parses to a typed expression tree internally. Its WASM boundary does not expose one.

Every call across that boundary is **string in, string out**: the plugin sends source text and
receives formatted HTML. It never receives a structure it could rewrite. That is why this is not a
matter of effort on the plugin side — there is no amount of TypeScript that turns formatted output
back into an expression tree you could differentiate, and re-parsing Numbat's own printed output in
JavaScript would mean reimplementing Numbat's parser and its type system, which is a large amount of
work and would be silly..

## Why a Close Fork is the Plausible Shape

This is less of a departure than it sounds. `scripts/build-wasm.xsh` already builds the WASM from
**pinned upstream source**. The build pipeline is ours already, and the change is what it points at,
not how it works. A fork changes one line of that script and nothing else about how the plugin is
built or shipped.

The discipline that makes it survivable is staying genuinely close:

- **Additive exports over the existing tree**, not a reworking of it. New wasm entry points that
  hand out or operate on the parsed representation, leaving evaluation exactly as it is.
- **Rebased onto upstream releases**, never diverged from them, so a version bump stays a rebase
  rather than a merge.

A fork that drifts would be a second interpreter to maintain, and this project cannot carry one.
While it would potentially be able to be upstreamed from a code perspective, Numbat has stated
explicitly that it does not want to be or aim to be a CAS.

This effort is **not the only thing that would benefit**, with the [soft fork](./soft-fork.md) note
laying out how existing features are constrained by the same boundary.

## Why not a JavaScript CAS Alongside Numbat

This is the obvious alternative and it is worth being explicit about rejecting it.
[MathJS](https://mathjs.org) parses to a manipulable tree and can differentiate and simplify today;
bolting it alongside the interpreter would be a weekend's work rather than a fork. It would also be
a different plugin. Two expression languages in one vault, with two notions of what a unit is,
disagreeing at the edges, and with no unit support.

A Numbat-based CAS brings **dimensional correctness through the symbolic layer.** Every CAS can
differentiate. None of them knows that d/dt of a `Length` expression is a `Velocity`, or that a
solution to an equation must be dimensionally consistent to be a solution at all. MathJS has units,
but as runtime values — they are checked when arithmetic happens, not when an expression is
manipulated.

Numbat's type system already checks dimensional consistency for evaluation. Carrying it through
symbolic manipulation is the same guarantee taken one step further. That is the reason to fork
Numbat rather than reach for a library, and it is the reason the feature is worth the cost at all.

## Open Questions

Realistically this would take two parts to do correctly. The first is a numbat fork that makes much
more of its internals part of the public API. The second is a distinct crate _built on top of that_
that implements the symbolic system and CAS features.

The following are open questions:

- **What the Boundary Should Carry:** An exported tree in some serialized form, or an opaque handle
  plus operations that act on it? The second keeps Numbat's invariants inside Numbat, at the price
  of a chattier boundary.
- **Where Simplification Lives:** Rewriting rules that respect dimensions are the interesting part,
  and they belong wherever the type checker is, or at least where the type-checker is _accessible_.
