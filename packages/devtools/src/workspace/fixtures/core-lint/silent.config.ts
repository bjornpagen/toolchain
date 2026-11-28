import { defineConfig } from "oxlint"

/**
 * A configuration that loads the dev tools' plugin by its path, holds two core rules at error, and turns on rules of
 * built-in plugins it does not load, which oxlint never runs: jsdoc's and promise's at its top, as edullm's preset did
 * (react's off, no fault), and react's in an override that loads vitest alone, beside vitest's, which it runs.
 */
export default defineConfig({
	jsPlugins: ["../../../oxlint-plugin.ts"],
	plugins: ["typescript"],
	rules: {
		"devtools/no-comment": "error",
		"devtools/no-raw-regexp": "error",
		"jsdoc/check-tag-names": "error",
		"promise/prefer-await-to-then": "warn",
		"react/jsx-key": "off",
		"typescript/no-explicit-any": "error"
	},
	overrides: [
		{
			files: ["**/*.test.ts"],
			plugins: ["vitest"],
			rules: { "react/no-danger": "error", "vitest/no-focused-tests": "error" }
		}
	]
})
