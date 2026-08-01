{
  description = "Symbat: the Numbat calculator language, inside Obsidian";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        # Everything needed to build, test, lint and release the plugin. CI runs inside this same
        # shell, so `make check` locally is what CI executes — there is no second copy of the
        # toolchain to drift from this one.
        devShells.default = pkgs.mkShell {
          packages = [
            # JavaScript and TypeScript
            pkgs.nodejs_24

            # Rust Integration
            pkgs.cargo
            pkgs.rustc
            pkgs.lld

            # wasm-bindgen's generated glue is version-locked to the CLI that emitted it, and numbat
            # v1.23.0's Cargo.lock pins wasm-bindgen 0.2.100 — hence the exact attribute rather than
            # the rolling one. scripts/build-wasm.xsh re-checks this against the lockfile and falls
            # back to `cargo install` if the two ever diverge.
            pkgs.wasm-bindgen-cli_0_2_100

            # Tooling
            pkgs.binaryen
            pkgs.git
            pkgs.gnumake
            pkgs.python314Packages.xonsh

            # Formatting
            pkgs.dprint
          ];
        };

        formatter = pkgs.nixfmt;
      }
    );
}
