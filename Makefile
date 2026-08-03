.DEFAULT_GOAL := help

# Flakes are still gated behind experimental-feature flags in a default Nix install, so pass them
# explicitly rather than making every contributor edit nix.conf.
NIX := nix --extra-experimental-features 'nix-command flakes'

# Every target runs inside the Nix devshell, which is the single definition of this project's
# toolchain. `IN_NIX_SHELL` is set by `nix develop`, so tasks run naturally if already inside the
# shell.
ifeq ($(IN_NIX_SHELL),)
  RUN := $(NIX) develop --command
else
  RUN :=
endif

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

# -- Building -------------------------------------------------------------------------------------

.PHONY: deps
deps: ## Install npm dependencies exactly as locked
	$(RUN) npm ci

.PHONY: wasm
wasm: ## Build the Numbat wasm bindings (a no-op once built for the pinned tag)
	$(RUN) npm run build:wasm

.PHONY: build
build: wasm typecheck ## Produce a release main.js
	$(RUN) npm run bundle

.PHONY: dev
dev: wasm ## Rebuild main.js on every change, with sourcemaps (Ctrl-C to stop)
	$(RUN) npm run bundle:watch

# -- Checking -------------------------------------------------------------------------------------

# `typecheck` and `lint` both need src/wasm/pkg: src/interpreter/numbat.ts imports the generated
# bindings, and the lint rules are type-aware. `test-unit` deliberately does not, which is what
# keeps the inner development loop fast.
#
# The bindings are committed, so the `wasm` prerequisite is satisfied by the checkout and does
# nothing on a normal run. It earns its place when NUMBAT_TAG has moved: the stamp no longer
# matches, the bindings are rebuilt, and CI fails until the new ones are committed.

.PHONY: typecheck
typecheck: wasm ## Type-check src/ and test/ without emitting
	$(RUN) npm run typecheck

.PHONY: lint
lint: wasm ## Run ESLint over the whole repository
	$(RUN) npm run lint

.PHONY: format-check
format-check: ## Report formatting that `make format` would change
	$(RUN) dprint check

.PHONY: test-unit
test-unit: ## Run the pure unit tests (no wasm needed)
	$(RUN) npm run test:unit

.PHONY: test-integration
test-integration: wasm ## Run the tests that drive the real Numbat interpreter
	$(RUN) npm run test:integration

.PHONY: test
test: test-unit test-integration ## Run every test

.PHONY: check
check: format-check typecheck lint test ## Everything CI checks

# -- Installing -----------------------------------------------------------------------------------

# `install` and `link` are two ways into the same vault folder, so they share these guards. `$@`
# expands where the block is used, which is what lets one copy name the target the user actually
# ran. Both checks happen before anything expensive, so a typo in DEV_VAULT_PATH costs a second
# rather than a full wasm build.
define vault-guard
	@if [ -z "$(DEV_VAULT_PATH)" ]; then \
		echo "make $@: DEV_VAULT_PATH is not set." >&2; \
		echo "  DEV_VAULT_PATH=~/vaults/dev make $@" >&2; \
		exit 1; \
	fi
	@if [ ! -d "$(DEV_VAULT_PATH)/.obsidian" ]; then \
		echo "make $@: '$(DEV_VAULT_PATH)' is not an Obsidian vault (no .obsidian directory)." >&2; \
		exit 1; \
	fi
endef

# main.js, manifest.json and styles.css are the three files Obsidian installs, and the folder they
# live in must be named after manifest.json's `id`. Read the id from the manifest rather than
# hardcoding it, so a rename cannot leave this target installing into a stale directory.
# The destination is checked before `build` rather than alongside it; that is what the recursive
# `$(MAKE)` buys, since prerequisite order is not guaranteed under `-j`.
.PHONY: install
install: ## Build and install into the vault at $DEV_VAULT_PATH
	$(vault-guard)
	@$(MAKE) --no-print-directory build
	@id=$$($(RUN) node -p "require('./manifest.json').id"); \
	dest="$(DEV_VAULT_PATH)/.obsidian/plugins/$$id"; \
	if [ -L "$$dest" ] && [ "$$(cd "$$dest" 2>/dev/null && pwd -P)" = "$$(pwd -P)" ]; then \
		echo "$$dest is a symlink to this checkout, so the build it already sees is the one just made."; \
		echo "Reload Obsidian, or disable and re-enable the plugin, to pick it up."; \
		exit 0; \
	fi; \
	mkdir -p "$$dest"; \
	cp main.js manifest.json styles.css "$$dest/" || exit 1; \
	echo "Installed $$id into $$dest."; \
	echo "Reload Obsidian, or disable and re-enable the plugin, to pick the build up."

# `link` is `install` without the copy: Obsidian follows a symlinked plugin folder, so pointing one
# at the checkout makes `make dev`'s rebuilt main.js live in the vault with no second step. It
# deliberately does not build — you link once and then leave `make dev` running — so a fresh
# checkout has no main.js yet, hence the reminder rather than a silent broken plugin. An existing
# destination is never removed here: a real directory is somebody's `make install` output (or, on a
# vault that has ever had the published plugin, their settings), and deleting either to save a
# `rm` is not a trade this target gets to make.
.PHONY: link
link: ## Symlink this checkout into the vault at $DEV_VAULT_PATH (pairs with make dev)
	$(vault-guard)
	@id=$$($(RUN) node -p "require('./manifest.json').id"); \
	dest="$(DEV_VAULT_PATH)/.obsidian/plugins/$$id"; \
	here=$$(pwd -P); \
	if [ -L "$$dest" ]; then \
		target=$$(cd "$$dest" 2>/dev/null && pwd -P); \
		if [ "$$target" = "$$here" ]; then \
			echo "Already linked: $$dest -> $$here"; \
		elif [ -z "$$target" ]; then \
			echo "make link: '$$dest' is a broken symlink." >&2; \
			echo "  Remove it and re-run: rm '$$dest'" >&2; \
			exit 1; \
		else \
			echo "make link: '$$dest' already links to '$$target', not this checkout." >&2; \
			echo "  Remove it and re-run: rm '$$dest'" >&2; \
			exit 1; \
		fi; \
	elif [ -e "$$dest" ]; then \
		echo "make link: '$$dest' exists and is a real directory, not a symlink." >&2; \
		echo "  It holds an installed copy of the plugin, and possibly its data.json." >&2; \
		echo "  Remove it yourself once you are sure, then re-run: rm -r '$$dest'" >&2; \
		exit 1; \
	else \
		mkdir -p "$$(dirname "$$dest")"; \
		ln -s "$$here" "$$dest"; \
		echo "Linked $$dest -> $$here."; \
	fi; \
	if [ ! -f main.js ]; then \
		echo "No main.js yet: run 'make dev' (or 'make build') before enabling the plugin."; \
	fi

# `unlink` is the way back from `link` to an ordinary install: drop the symlink and leave the three
# files Obsidian ships in its place. The build runs *before* the symlink goes, so a failing build
# leaves the vault with the plugin it already had rather than an empty folder. `data.json` comes
# along if the checkout has one, because that is where a linked plugin has been writing its
# settings, and silently resetting them on the way back would be a poor trade for a `cp`.
.PHONY: unlink
unlink: ## Replace the $DEV_VAULT_PATH symlink with a copied build
	$(vault-guard)
	@id=$$($(RUN) node -p "require('./manifest.json').id"); \
	dest="$(DEV_VAULT_PATH)/.obsidian/plugins/$$id"; \
	if [ ! -L "$$dest" ]; then \
		if [ -d "$$dest" ]; then \
			echo "make unlink: '$$dest' is a real directory, not a symlink." >&2; \
			echo "  It is already a copied install; 'make install' refreshes it in place." >&2; \
		else \
			echo "make unlink: nothing is linked at '$$dest'." >&2; \
			echo "  'make install' puts a copied build there." >&2; \
		fi; \
		exit 1; \
	fi; \
	was=$$(cd "$$dest" 2>/dev/null && pwd -P); \
	$(MAKE) --no-print-directory build || exit 1; \
	rm "$$dest"; \
	mkdir -p "$$dest"; \
	cp main.js manifest.json styles.css "$$dest/" || exit 1; \
	if [ -f data.json ]; then \
		cp data.json "$$dest/" || exit 1; \
		echo "Copied data.json across, so the plugin keeps the settings it had while linked."; \
	fi; \
	echo "Unlinked $$id: $$dest is a copy of the build, and no longer a symlink to $$was."; \
	echo "Reload Obsidian, or disable and re-enable the plugin, to pick it up."

# -- Utility --------------------------------------------------------------------------------------

.PHONY: format
format: ## Reformat Markdown, JSON, CSS, TOML and TypeScript
	$(RUN) dprint fmt

# src/wasm/pkg is deliberately left alone: it is tracked now, so removing it here would leave a
# dirty tree for anyone who ran `make clean` out of habit. To force the bindings to be rebuilt --
# which is what the release workflow does, so a release cannot merely ship what was committed --
# delete them explicitly: `rm -rf src/wasm/pkg && make wasm`.
.PHONY: clean
clean: ## Remove build output, keeping the numbat checkout and node_modules
	rm -rf main.js main.js.map

.PHONY: distclean
distclean: clean ## Also remove the numbat checkout and node_modules
	rm -rf .build node_modules

.PHONY: shell
shell: ## Launch $$SHELL inside the devshell
	$(NIX) develop --command $(shell echo $$SHELL)

.PHONY: editor
editor: ## Launch $$EDITOR inside the devshell
	$(NIX) develop --command $(EDITOR)
