// The LaTeX-style `\code` table, mirrored from Numbat's `numbat/src/unicode_input.rs` at the pinned
// `NUMBAT_TAG` (v1.23.0). Numbat itself borrows the list from Julia's Unicode input, and supports a
// deliberately small subset of it.
//
// **Why a copy rather than a question.** The expansion runs inside CodeMirror's `inputHandler`,
// whose contract is `(view, from, to, text) => boolean` — there is no point in that signature where
// a promise can be awaited, so the answer has to be available on the keystroke itself. Asking the
// wasm meant keeping an interpreter instance alive on the main thread purely to consult a constant,
// and building the completion popover's list cost one call per name in Numbat's whole vocabulary.
// The table is static: it depends on neither the prelude, the user's settings, nor exchange rates.
//
// **It is generated, not typed.** The entries below are a mechanical transcription of the Rust
// array, in its order and under its section comments, so the two can be diffed line by line when
// `NUMBAT_TAG` moves. `test/integration/unicode/table.test.ts` is what actually holds them
// together: it asserts, in both directions, that this table and the real wasm agree.
//
// Two pairs look like duplicates and are not — `Omega` is U+03A9 and `ohm` is U+2126, `mu` is
// U+03BC and `micro` is U+00B5. Numbat distinguishes them, so this file does too.

/**
 * One row of the table: the code names (aliases share a replacement) and the text they expand to.
 * Names carry no leader — `alpha`, not `\alpha`.
 */
export type UnicodeEntry = readonly [codes: readonly string[], replacement: string];

/** Every `\code` Numbat knows, in the upstream file's order. */
export const UNICODE_INPUT: readonly UnicodeEntry[] = [
  [["pm"], "±"],

  // Superscript symbols
  [["^-"], "⁻"],
  [["^+"], "⁺"],
  [["^0"], "⁰"],
  [["^1"], "¹"],
  [["^2"], "²"],
  [["^3"], "³"],
  [["^4"], "⁴"],
  [["^5"], "⁵"],
  [["^6"], "⁶"],
  [["^7"], "⁷"],
  [["^8"], "⁸"],
  [["^9"], "⁹"],

  // Subscript symbols
  [["_-"], "₋"],
  [["_+"], "₊"],
  [["_0"], "₀"],
  [["_1"], "₁"],
  [["_2"], "₂"],
  [["_3"], "₃"],
  [["_4"], "₄"],
  [["_5"], "₅"],
  [["_6"], "₆"],
  [["_7"], "₇"],
  [["_8"], "₈"],
  [["_9"], "₉"],

  // Numbers
  [["1/2"], "½"],

  // Operators
  [["cdot"], "⋅"],
  [["cdotp"], "·"],
  [["times"], "×"],
  [["div"], "÷"],
  [["to", "rightarrow"], "→"],
  [["ge"], "≥"],
  [["le"], "≤"],
  [["dots", "ldots"], "…"],

  // Greek alphabet
  [["Gamma"], "Γ"],
  [["Delta"], "Δ"],
  [["Theta"], "Θ"],
  [["Lambda"], "Λ"],
  [["Pi"], "Π"],
  [["Sigma"], "Σ"],
  [["Phi"], "Φ"],
  [["Psi"], "Ψ"],
  [["Omega"], "Ω"],
  [["alpha"], "α"],
  [["beta"], "β"],
  [["gamma"], "γ"],
  [["delta"], "δ"],
  [["epsilon"], "ϵ"],
  [["varepsilon"], "ε"],
  [["zeta"], "ζ"],
  [["eta"], "η"],
  [["theta"], "θ"],
  [["vartheta"], "ϑ"],
  [["iota"], "ι"],
  [["kappa"], "κ"],
  [["lambda"], "λ"],
  [["mu"], "μ"],
  [["nu"], "ν"],
  [["xi"], "ξ"],
  [["pi"], "π"],
  [["rho"], "ρ"],
  [["sigma"], "σ"],
  [["tau"], "τ"],
  [["upsilon"], "υ"],
  [["phi"], "ϕ"],
  [["varphi"], "φ"],
  [["chi"], "χ"],
  [["psi"], "ψ"],
  [["omega"], "ω"],

  // Currency
  [["dollar"], "$"],
  [["euro"], "€"],
  [["sterling", "pound"], "£"],
  [["yen"], "¥"],
  [["rupee"], "₹"],
  [["won"], "₩"],
  [["lira"], "₺"],
  [["peso"], "₱"],
  [["baht"], "฿"],
  [["shekel"], "₪"],

  // Units
  [["micro"], "µ"],
  [["degree"], "°"],
  [["arcmin"], "′"],
  [["arcsec"], "″"],
  [["ohm"], "Ω"],
  [["Angstrom"], "Å"],
  [["percent"], "%"],
  [["perthousand"], "‰"],
  [["pertenthousand"], "‱"],

  // Constants
  [["hbar"], "ℏ"],
  [["planck"], "ℎ"],
];
