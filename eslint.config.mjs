import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated: the wasm-bindgen glue and the esbuild bundle.
  { ignores: ["src/wasm/**", "main.js", ".build/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...obsidianmd.configs.recommended,
  {
    // Scoped to TypeScript on purpose. `projectService` resolves each file through the nearest
    // tsconfig, and the repo's .mjs config files are in no tsconfig at all — linting them under
    // this block is an error, not a finding.
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

      // Comment width, which dprint does not police: its TypeScript plugin exposes no equivalent of
      // the Markdown plugin's `textWrap`, and treats a comment's text as opaque. Without this the
      // 100-column convention is the one rule on CONTRIBUTING's list that nothing checks.
      //
      // `code` matches dprint's own lineWidth so the two cannot disagree; the literal exemptions are
      // for lines dprint physically cannot break (a long string has no break point). This reports
      // but cannot fix — `max-len` is not fixable — so a violation is re-wrapped by hand.
      //
      // Deprecated in ESLint 9 and slated to go in 10, along with every other stylistic core rule.
      // The drop-in replacement is `@stylistic/max-len`, same options, at the cost of a dependency
      // for one rule; worth taking when this stops working, not before.
      "max-len": ["error", {
        code: 120,
        comments: 100,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
        // An ESLint directive has to stay on one line to keep working, so it cannot be wrapped.
        ignorePattern: "eslint-disable",
      }],

      // "Numbat" is a proper noun and "REPL" an acronym; the sentence-case heuristic mangles both,
      // so it is not useful here.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  {
    // The answering side of the interpreter seam must stay loadable where the wasm runs and nowhere
    // else: no Obsidian, no DOM host, no CodeMirror, no plugin object. Today that is what makes it
    // drivable from `test/integration`; once it runs in a worker, a stray `import { Notice } from
    // "obsidian"` yields a worker that throws on load and falls back silently, forever. Caught at
    // lint time, because by build time it is a runtime failure nobody sees.
    files: ["src/interpreter/worker/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "obsidian", message: "The interpreter's answering side must not depend on Obsidian." },
          { name: "electron", message: "The interpreter's answering side must not depend on Electron." },
        ],
        patterns: [
          {
            group: ["@codemirror/*", "@lezer/*"],
            message: "The interpreter's answering side must not depend on the editor.",
          },
          {
            group: ["**/main", "**/main.ts"],
            message: "The interpreter's answering side must not reach for the plugin object.",
          },
          {
            group: ["node:*"],
            message: "The interpreter's answering side must not depend on Node built-ins.",
          },
        ],
      }],
    },
  },
  {
    // The tests run under node, not inside Obsidian. The recommended config withholds Node globals
    // and forbids `node:` imports because the manifest declares isDesktopOnly: false — which
    // constrains the plugin, not its test suite.
    files: ["test/**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      // Same reason: the rule is about Obsidian's popout windows, and there is no `window` here at
      // all — `window.setTimeout` would be a ReferenceError rather than an improvement.
      "obsidianmd/prefer-window-timers": "off",
      // node:test's `test()` returns a promise that callers are meant to discard — the runner is
      // what awaits it. Otherwise every test in the suite would need a `void` in front of it.
      "@typescript-eslint/no-floating-promises": "off",
      // The wasm bindings are imported dynamically and ship no usable types, so the suite types the
      // module as `any` deliberately. These rules exist to stop `any` spreading through the plugin,
      // and still do so in src/.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Build scripts: plain ESM run by node, outside any tsconfig.
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "obsidianmd/no-nodejs-modules": "off",
      // Both rules here are about what the *plugin* may do inside somebody's vault, and a build
      // script is not the plugin. Printing what was produced — the two bundle sizes, and which
      // budget was blown when one is — is the reason a build script has a stdout.
      "obsidianmd/rule-custom-message": "off",
    },
  },
);
