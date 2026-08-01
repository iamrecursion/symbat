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
    // The tests run under node, not inside Obsidian. The recommended config withholds Node globals
    // and forbids `node:` imports because the manifest declares isDesktopOnly: false — which
    // constrains the plugin, not its test suite.
    files: ["test/**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
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
    },
  },
);
