<!-- Thanks for the contribution. Please read docs/CONTRIBUTING.md if you have not already. -->

## Description

<!-- What the change does, and why. If it fixes an issue, say `Fixes #123`. -->

## How it was Verified

<!--
`make check` is necessary but rarely sufficient. Anything touching the editor, the settings tab, or
mobile needs a real vault. Say which surfaces you actually exercised, and on what.
-->

- [ ] `make check` passes from a clean tree (format, typecheck, lint, unit + integration tests)
- [ ] Exercised in a real vault — surfaces touched:
- [ ] Tested on mobile (only if the change touches layout, the keyboard, or touch input)

## Tests

- [ ] New behavior has tests, or this section says why it cannot
- [ ] Pure logic is tested in `test/unit/` (no Obsidian imports anywhere in its import graph)
- [ ] Interpreter behavior is pinned in `test/integration/`

## Docs

- [ ] `docs/features.md` has been updated if behavior changed
- [ ] `docs/architecture.md` has been updated if the module structure or the invalidation flow changed
- [ ] Module headers say what any new module is and _why_ it is separate from its neighbors

## Naming

<!-- Only relevant if this touches user-facing strings or identifiers. -->

- [ ] The plugin is called **Symbat**; the language is called **Numbat**
- [ ] No change to the `numbat` fences, `.nbt`, `numbat-use`, `numbat:expression`, settings keys,
      wasm symbols, or `numbat-*` CSS classes
- [ ] The `VIEW_TYPE_NUMBAT_*` constants are unchanged and referenced by name, not as string
      literals

## Anything Else

<!-- Trade-offs you made, things you were unsure about, things you would like looked at closely. -->
