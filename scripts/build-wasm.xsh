#!/usr/bin/env xonsh
# Build the Numbat WebAssembly bindings from a pinned sharkdp/numbat checkout.
#
# Output: src/wasm/pkg/{numbat_wasm.js, numbat_wasm_bg.wasm, numbat_wasm.d.ts}, which the esbuild 
# bundle inlines. Nothing generated is committed — this runs as part of `make build` / `make dev`.
#
# Requirements: a Rust toolchain that can target wasm32-unknown-unknown, a matching `wasm-bindgen` 
# CLI, and network access to github.com and crates.io. The Nix devshell (`nix develop`, or any 
# `make` target) supplies all of these, including `wasm-opt`. Outside it, `rust-toolchain.toml` pins
# the equivalent toolchain for rustup, and a missing `wasm-bindgen` is installed via cargo.
#
# Environment:
#   REQUIRE_WASM_OPT=1  fail rather than ship an unoptimized (~3x larger) wasm.

import os
import shutil
import subprocess
import sys
from pathlib import Path

# Abort the whole script if any subprocess command fails (like `set -e`).
$XONSH_SUBPROC_CMD_RAISE_ERROR = True

NUMBAT_TAG = "v1.23.0"
NUMBAT_REPO = "https://github.com/sharkdp/numbat.git"

# rustup installs cargo/rustc/wasm-bindgen shims here, and a non-interactive `nix develop --command` 
# may not add it to PATH. Append rather than prepend: prepending lets a contributor's rustup shims 
# shadow the devshell's pinned toolchain, so the build silently stops being the one the flake
# describes.
cargo_bin = Path($CARGO_HOME if "CARGO_HOME" in ${...} else str(Path.home() / ".cargo")) / "bin"
if str(cargo_bin) not in $PATH:
    $PATH.append(str(cargo_bin))

# Resolve paths relative to this script (scripts/ lives in the plugin root).
try:
    script_dir = Path(__file__).resolve().parent
except NameError:
    script_dir = Path.cwd() / "scripts"
plugin_dir = script_dir.parent
build_dir = plugin_dir / ".build" / "numbat"
wasm_crate = build_dir / "numbat-wasm"
out_dir = plugin_dir / "src" / "wasm" / "pkg"

# Two stamps, so each directory describes what it actually holds. The source stamp decides whether
# the checkout must be refetched; the output stamp decides whether there is anything to do at all. 
# Both are written only after the step they describe succeeds, so an interrupted run never claims to
# be up to date.
src_tag_file = build_dir / ".numbat-tag"
out_tag_file = out_dir / ".numbat-tag"

def stamped(path):
    return path.read_text().strip() if path.exists() else None

# Skip if the bindings were already built from the pinned tag (delete src/wasm/pkg to force a
# rebuild).
if (out_dir / "numbat_wasm_bg.wasm").exists() and stamped(out_tag_file) == NUMBAT_TAG:
    print(f"numbat-wasm already built for {NUMBAT_TAG}; skipping.")
    sys.exit(0)

# 1. Fetch the pinned Numbat source. Gate this on the source stamp, not merely on the directory 
#    existing: bumping NUMBAT_TAG must refetch, or the old sources get rebuilt and stamped with the 
#    new tag.
(plugin_dir / ".build").mkdir(parents=True, exist_ok=True)
if stamped(src_tag_file) != NUMBAT_TAG or not wasm_crate.exists():
    print(f"Cloning numbat {NUMBAT_TAG}...")
    if build_dir.exists():
        shutil.rmtree(build_dir)
    git clone --depth 1 --branch @(NUMBAT_TAG) @(NUMBAT_REPO) @(str(build_dir))
    src_tag_file.write_text(NUMBAT_TAG + "\n")

# 2. Ensure the wasm target. Only rustup toolchains need this; the devshell's rustc already ships
#    the wasm32 std, and rustup may not be installed at all.
if shutil.which("rustup"):
    subprocess.run(["rustup", "target", "add", "wasm32-unknown-unknown"], check=False)

# 3. Compile the crate to wasm. `--locked` holds the build to the lockfile the tag was published
#    with, so the output depends on NUMBAT_TAG alone. RUSTFLAGS is scoped to this one command: 
#    setting it process-wide leaks into the `cargo install` below, which builds a host binary that
#    must not see it.
print(f"Compiling numbat-wasm ({NUMBAT_TAG}) for wasm32-unknown-unknown...")
with ${...}.swap(RUSTFLAGS='--cfg getrandom_backend="wasm_js"'):
    cargo build --release --locked --target wasm32-unknown-unknown --manifest-path @(str(wasm_crate / "Cargo.toml"))

# 4. Ensure a wasm-bindgen CLI matching the crate's wasm-bindgen version. The generated glue is 
#    version-locked to the CLI that emitted it, so a mismatch produces bindings that fail at
#    instantiation rather than at build time.
lock = wasm_crate / "Cargo.lock"
if not lock.exists():
    lock = build_dir / "Cargo.lock"
needed = None
lock_lines = lock.read_text().splitlines()
for idx, line in enumerate(lock_lines):
    if line.strip() == 'name = "wasm-bindgen"':
        for probe in lock_lines[idx + 1:idx + 3]:
            if probe.strip().startswith("version"):
                needed = probe.split('"')[1]
        break

have = ""
if shutil.which("wasm-bindgen"):
    have = $(wasm-bindgen --version).split()[1]
if needed and have != needed:
    print(f"Installing wasm-bindgen-cli {needed} (current: {have or 'none'})...")
    cargo install wasm-bindgen-cli --version @(needed) --locked

# 5. Generate the web bindings.
print("Generating JS bindings...")
if out_dir.exists():
    shutil.rmtree(out_dir)
out_dir.mkdir(parents=True, exist_ok=True)
wasm_file = wasm_crate / "target" / "wasm32-unknown-unknown" / "release" / "numbat_wasm.wasm"
wasm-bindgen --target web --out-dir @(str(out_dir)) --out-name numbat_wasm @(str(wasm_file))

# The generated `*_bg.wasm.d.ts` types the wasm as a module and conflicts with our esbuild `binary`
# loader (which yields a Uint8Array). Remove it so the ambient `*.wasm` declaration in src/wasm.d.ts
# applies.
(out_dir / "numbat_wasm_bg.wasm.d.ts").unlink(missing_ok=True)

# Add a reset hook: after a Rust panic the wasm instance is unreliable, so the plugin reinitializes
# it. wasm-bindgen's `init` refuses to re-run once `wasm` is set, so expose a function (in the
# module scope) that clears it, letting the next `init()` build a fresh instance.
glue = out_dir / "numbat_wasm.js"
glue.write_text(glue.read_text() + "\nexport function __numbat_reset() { wasm = undefined; }\n")
glue_dts = out_dir / "numbat_wasm.d.ts"
glue_dts.write_text(glue_dts.read_text() + "\nexport function __numbat_reset(): void;\n")

# 6. Shrink the binary. This is worth roughly 3x on the bundle, so a release build sets
#    REQUIRE_WASM_OPT to make a missing binaryen an error rather than a line of output nobody reads.
bg_wasm = out_dir / "numbat_wasm_bg.wasm"
if shutil.which("wasm-opt"):
    print("Optimizing with wasm-opt...")
    wasm-opt -Oz -o @(str(bg_wasm)) @(str(bg_wasm))
elif os.environ.get("REQUIRE_WASM_OPT", "") not in ("", "0"):
    sys.exit("REQUIRE_WASM_OPT is set but wasm-opt (binaryen) is not on PATH.")
else:
    print("wasm-opt (binaryen) not found; shipping unoptimized wasm.")

# Stamp last: everything above succeeded, so the output really is this tag.
out_tag_file.write_text(NUMBAT_TAG + "\n")

print(f"Done: {out_dir} ({bg_wasm.stat().st_size // 1024} KiB)")
