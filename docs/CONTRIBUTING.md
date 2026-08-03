# Contributing

Thanks for taking an interest in contributing to Symbat! This document covers getting a working
checkout, building the plugin, and how a release is cut! Do think whether your contribution belongs
in Symbat, or in [Numbat](https://github.com/sharkdp/numbat#development) itself.

Before you write anything substantial, please open an
[issue](https://github.com/iamrecursion/symbat/issues/new/choose) or a
[discussion](https://github.com/iamrecursion/symbat/discussions). Much of the way this plugin is
written is subtle and non-obvious, so it is worth taking a look at
[the architecture doc](./architecture.md) as that explains the most surprising parts of the design!
It is always cheaper to talk about an approach than to review one.

## Building

We use a [Nix](https://lix.systems)-based development environment, so we recommend that you
[install](https://lix.systems/install/) it before doing anything else. The plugin bundles a
WebAssembly build of [`sharkdp/numbat`](https://github.com/sharkdp/numbat), and that build —
`src/wasm/pkg` — is the one generated thing this repository commits, for the reason given under
[Building the WASM](#building-the-wasm). The bundle itself (`main.js`) is not.

```sh
nix develop        # Rust, Node, xonsh, wasm-bindgen, binaryen, dprint
make build         # type-check and bundle main.js (the wasm comes with the checkout)
make check         # exactly what CI runs
```

## Getting Started

This repository ships a [Nix](https://lix.systems) flake, which describes the single definition of
this project's toolchain. CI runs inside the same shell, executing the same `make` targets, so using
the `make` targets is the best way to replicate CI locally.

```sh
git clone https://github.com/iamrecursion/symbat.git
cd symbat
nix develop        # or: make shell
make deps          # npm ci
make build         # builds the wasm, type-checks, bundles main.js
```

Every `make` target wraps itself in `nix develop --command` when you are not already inside the
shell, so `make check` works from a bare terminal too but will be a little bit slower to start.

`make help` lists every target, but the main ones you will use are listed below.

| Target           | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `make build`     | wasm + typecheck + bundle — a release `main.js`                 |
| `make dev`       | rebuild `main.js` on change, with sourcemaps                    |
| `make install`   | build, then copy the plugin into `$DEV_VAULT_PATH`              |
| `make link`      | symlink this checkout into `$DEV_VAULT_PATH` instead of copying |
| `make unlink`    | swap that symlink back for a copied build                       |
| `make check`     | **everything CI checks**: format, typecheck, lint, all tests    |
| `make test-unit` | the pure tests only — fast, no wasm needed                      |
| `make format`    | reformat Markdown, JSON, CSS, TOML, and TypeScript with dprint  |
| `make clean`     | drop build output, keep the numbat checkout and `node_modules`  |

We do not really support building without Nix (and hence recommend using WSL for development on
Windows). If you want to try anyway, you will at a minimum need: Node.js 24, a Rust toolchain that
can target `wasm32-unknown-unknown`, `xonsh`, `wasm-bindgen-cli` **0.2.100**, `lld`, and `binaryen`
(for `wasm-opt`) — the last of which the wasm build now insists on, since without it the wasm is
roughly three times larger and that is what would be committed.

### Testing in a Real Vault

When installing a plugin, Obsidian copies `main.js`, `manifest.json` and `styles.css` to the plugin
folder. For convenience, we make this easy by providing `make install` used as follows:

```sh
export DEV_VAULT_PATH=~/vaults/dev
make install
```

The destination folder is named from `manifest.json`'s `id`, so it cannot drift from what Obsidian
looks for. The target refuses a path with no `.obsidian` directory in it, and checks that **before**
building rather than after. Obsidian does not notice the new files on its own, so you will need to
reload it or disable and re-enable the plugin.

For a more seamless workflow for rapid development, you can also use `make link`, which symlinks the
repository into `<vault>/.obsidian/plugins/` rather than copying into it. Obsidian follows the
symlink, so a rebuild is live in the vault with no second step, which pairs well with `make dev`.

```sh
export DEV_VAULT_PATH=~/vaults/dev
make link
```

It takes the same two guards as `make install` and deliberately does not build, since the intent is
that you link once and leave `make dev` running — so a fresh checkout has no `main.js` yet, and the
target says so rather than leaving you with a plugin Obsidian cannot load. It never removes what is
already at the destination: if `make install` has put a real folder there, `make link` tells you to
delete it yourself, because that folder may hold your `data.json`. Once linked, the settings
Obsidian writes land in the checkout itself, which the `.gitignore` already accounts for. Reloading
is still on you — Obsidian does not watch the file for changes.

`make unlink` is the way back. It builds, removes the symlink, and copies the same three files in
its place, leaving the vault with an ordinary install:

```sh
export DEV_VAULT_PATH=~/vaults/dev
make unlink
```

The build happens **before** the symlink goes, so a build that fails leaves the vault with the
plugin it already had rather than an empty folder. The checkout's `data.json` is copied across if
there is one, since that is where the linked plugin has been keeping its settings.

### Building the WASM

Handling the WASM build is done using [`scripts/build-wasm.xsh`](../scripts/build-wasm.xsh), which
handles the entire build process. It clones a **pinned** version of `sharkdp/numbat`, builds its
`numbat-wasm` crate for `wasm32-unknown-unknown`, runs `wasm-bindgen --target web`, patches the
generated glue with a `__numbat_reset()` export, and then optimizes the result with `wasm-opt -Oz`.
The output then lands in `src/wasm/pkg`, which is then inlined by esbuild.

**The output is committed**, which is the one exception to this repository's rule about generated
files. Obsidian's plugin review builds a clean checkout with nothing but `npm ci && npm run build`,
and no amount of packaging makes a Rust toolchain, a version-matched `wasm-bindgen` and `binaryen`
appear on that path — so a repository that can only produce its bundle inside the devshell cannot be
reviewed. `npm run build` therefore type-checks and bundles, and nothing more; regenerating the
bindings is `make wasm`, and only a `NUMBAT_TAG` bump needs it.

**The release ships these bytes as they are**, rather than rebuilding them, which is worth
explaining because the opposite is the more obvious choice. Obsidian's review builds the tagged
source and compares the result against the released `main.js`, so the two have to be the same
bundle; since esbuild inlines the wasm, that means the release must inline the committed binary. It
cannot also compile from source during the release run, because the Numbat wasm build is **not
reproducible** — two builds of the same tag, on the same machine, in this same devshell, differ by a
few hundred bytes of data-segment layout. Same strings, same behaviour, different bytes. So a
rebuilt release could never match a clean-checkout build, and 1.0.1 was flagged for exactly that.

What holds the bindings up instead: `build-wasm.xsh` is the only thing that writes them, CI fails if
they do not carry the pinned tag or if they look unoptimized, the release workflow re-checks the
stamp before it builds, and the release assets carry a build provenance attestation. Regenerating
them is therefore a deliberate step before a release tag, not something a workflow does for you.

- **The pinned tag lives at the top of the script** as `NUMBAT_TAG`. Bumping it is a deliberate
  change: it moves the entire standard library the plugin ships — and you must commit the
  regenerated `src/wasm/pkg` along with it, which CI checks.
- The **two stamp files** (`.build/numbat/.numbat-tag` and `src/wasm/pkg/.numbat-tag`) record which
  tag each directory actually holds, and each is written only after its step succeeds. That is what
  makes the build skippable without making a tag bump silently rebuild old sources under a new name.
- **A missing `wasm-opt` is a hard failure**, since the output is committed and shipped verbatim, so
  a silent 3× size regression would reach every vault. `REQUIRE_WASM_OPT=0` overrides that for a
  local experiment; CI's size ceiling on `numbat_wasm_bg.wasm` is there for when it is not.
- **`--remap-path-prefix`** rewrites the numbat checkout and the cargo registry to `/numbat` and
  `/cargo`. rustc otherwise names every source file by its absolute path in panic messages and debug
  info, which — now that the bindings are committed to a public repository — would publish the home
  directory of whoever built them. It also removes the largest single source of difference between
  two machines building the same tag.
- The script is written in **xonsh** for maintainability and readability. The flake provides it, so
  the devshell remains the supported way to build the plugin.

To force a rebuild, delete `src/wasm/pkg/` and run `make wasm`. `make clean` deliberately leaves it
alone, since it is tracked and removing it would leave you with a dirty tree.

### Tests

The tests are split across two suites:

- **`test/unit/`** runs under plain Node with no Obsidian and no WASM. A unit test can therefore
  only load a module whose _entire transitive import graph_ is Obsidian-and-WASM-free. That is what
  keeps the pure layer pure. Adding an `import { Notice } from "obsidian"` to a parsing module makes
  its test stop loading, immediately and loudly. If a change means a pure module has to reach for
  Obsidian, the answer is **almost always a second module**, not a looser rule.
- **`test/integration/`** loads the real WASM and asserts against actual Numbat behavior. Several of
  these files exist specifically to pin surprising interpreter facts (`let m = 5` is an identifier
  clash, `let pi = 3` silently shadows), so a Numbat version bump surfaces the difference early
  rather than in actual usage.

Both suites mirror `src/`'s folders, so a module's tests sit at the matching path. For example,
`src/scope/model.ts` is covered by `test/unit/scope/model.test.ts`, and the interpreter behavior it
assumes is pinned in `test/integration/scope/`. The runner is given a `**` glob rather than a
directory list, so a new folder needs no explicit wiring.

Integration tests are automatically skipped when `src/wasm/pkg` is missing, so `make test-unit`
stays fast. However, `test/integration/wasm-pkg.ts` **throws** rather than skipping when `CI` is
set, so a CI run cannot report success on 63 tests it never _actually_ executed.

When fixing a bug, the useful question is **which suite would have caught it**. Most of this
codebase's historical bugs were two surfaces disagreeing, and those are unit-testable once the
disagreement is extracted into a shared module (which is why there are so many of them).

### Style

Coding style in this repository is mostly automated, so just keep the following in mind:

- **Passing `make check` is Not Optional:** This checks formatting, the typecheck, linting, and runs
  both test suites. `src/` is expected to be completely warnings clean, while `test/` has documented
  exemptions in `eslint.config.mjs`. Adding an exception will be subject to significant scrutiny and
  require justtification.
- **DPrint Handles Formatting:** Run `make format` rather than arguing with it; a rename that
  changes a name's alphabetical position will reorder an import block and that is fine.
- **Keep `src/` Organized:** It is grouped by concern with one folder each, and a folder holds all
  layers of what it is concerned with. If the files need to change together, they probably should
  live in the same concern. Look at the [architecture doc](./architecture.md#the-shape-of-src) for a
  description of what each folder holds.
- **Module Headers are Useful:** Nearly every file in `src/` opens with a comment that describes
  what it is and why it is separate from its neighbors. All new modules should do this. Naming
  siblings should be by path inside `src` so references remain unambiguous.
- **Explain Non-Obvious Things:** Due to the way we use (and abuse) the WASM entry points for
  Numbat, Symbat has to do a bunch of quite subtle things. Comments are key for keeping us sane and
  explaining the subtleties.
- **Wrap Comments at 100 Columns:** `make check` enforces the ceiling through ESLint's `max-len`,
  because `dprint` will not: its `lineWidth` of 120 applies to _code_, and its TypeScript plugin
  treats a comment's text as opaque. The rule reports but cannot fix, so re-wrapping is by hand —
  prose fills to 100, and a bullet's continuation lines align under its text. Dividers, fenced
  samples, and tooling directives such as `// eslint-disable-next-line` are exempt and should be
  left alone; a wrapped directive silently stops working.

### Naming: Symbat and Numbat

**The plugin is Symbat. The language is Numbat.** This distinction is enforced throughout and is not
negotiable in a PR:

- **Rename-Eligible**: The plugin's identity — `manifest.json`, the settings tab, view titles,
  ribbon tooltips, log prefixes, and the `Symbat*` classes.
- **Not Rename-Eligible**: The `` ```numbat `` and `` ```numbat-shared `` fences, the `.nbt`
  extension, the `numbat-use` property, the `numbat:expression` property-type id, every settings
  key, the wasm symbols, and the `numbat-*` CSS classes. These name the language, and the CSS
  classes in particular are derived from what the wasm's own formatter emits.
- **Compatibility Contracts**: `VIEW_TYPE_NUMBAT_FILE`, `VIEW_TYPE_NUMBAT_REPL`, and
  `VIEW_TYPE_NUMBAT_SCOPE` are persisted in the vault's `workspace.json`. Renaming one turns every
  open pane of that type into a "No view of type…" placeholder. Reference them through the exported
  constants, never as string literals.

## Pull Requests

Making a PR in this repository follows the standard workflow.

1. Branch off `main`. Keep a PR to one change, we don't want to review two things happening at once.
   Feel free to use the stacked PRs feature where relevant.
2. State explicitly what you verified, as `make check` passing is necessary but rarely sufficient.
   Most things still need to be tested with a real vault, so please say what you did.
3. Update docs in sync. We use the [features doc](./features.md) to document behavior, while the
   [architecture doc](./architecture.md) documents structure, intent, and invalidation.

Reviews in general will focus on whether a change makes a class of bug impossible rather than fixing
one instance of it. This is the standard that all existing development has been held to.

## Continuous Integration

There are four CI workflows, but none of them do anything that you cannot run locally.

- [`ci.yml`](../.github/workflows/ci.yml) runs on every push and PR. It does the equivalent of
  `make check` and also runs a full build.
- [`release.yml`](../.github/workflows/release.yml) runs on every version tag. See
  [below](#Releasing).
- [`nix.yml`](../.github/workflows/release.yml) runs on flake or build script changes, plus weekly.
  It is a simple flake check, combined with a check that the flake's two pins agree with the rest of
  the repository.
- [`nix.yml`](../.github/workflows/update-flake-lock.yml) runs monthly and opens a PR with
  `nix flake update` having been run.

If you bump dprint in the flake, you must bump `dprint-version` in `ci.yml` to match and run
`make format`; `nix.yml` will tell you if you forget.

## Releasing

Obsidian resolves a release by looking for a **git tag identical to `manifest.json`'s `version`** —
`1.0.0`, never `v1.0.0`. `.npmrc` sets `tag-version-prefix=` so `npm version` cannot get this wrong;
do not remove it.

```sh
make check                     # green, from a clean tree
npm version <major|minor|patch>
```

`npm version` runs `version-bump.mjs`, which writes the new version into `manifest.json` and adds a
`versions.json` entry mapping it to the current `minAppVersion`, then stages both. Then:

```sh
git push --follow-tags
```

The release workflow validates the tag against both `manifest.json` and `package.json`, checks for
the `versions.json` entry, builds, and opens a **draft** release with `main.js`, `manifest.json`,
and `styles.css` attached as individual root-level assets. Obsidian does not look inside a source
archive. Review the draft, then publish it, as Obsidian only sees published releases.

The workflow builds from the committed wasm bindings and never rebuilds them, so that the released
`main.js` is byte-for-byte what the tagged source builds — Obsidian's review checks precisely that,
and [the WASM section](#building-the-wasm) explains why it cannot be had any other way. Two
consequences for a release: the bindings must already be current (the workflow refuses to build if
their stamp does not match `NUMBAT_TAG`), and the assets must not be rebuilt or replaced by hand
afterwards, which would both break that match and drop their attestation. If a published release
needs different bytes, it needs a new version.

**Raising `minAppVersion`** is a separate decision from bumping the version, and it changes what
`versions.json` means: Obsidian scans that file for the highest plugin version whose `minAppVersion`
is at most the user's app version, and offers that release. An entry pointing at a release that does
not exist is a 404 for the user, not a graceful fallback.

## AI / LLM Policy

This repository is perfectly open to code created using LLMs as long as it is well tested and the
potential contributor takes full responsibility for their code. However, communication in issues,
PRs, and commit messages should be between humans, with any LLM-generated text clearly attributed.
