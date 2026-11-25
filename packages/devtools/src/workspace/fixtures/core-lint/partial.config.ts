import { defineConfig } from "oxlint"

/** A configuration that loads the dev tools' plugin by its path, holds two core rules at error, turns a third off and a
 * fourth down to a warning. */
export default defineConfig({
	jsPlugins: ["../../../oxlint-plugin.ts"],
	rules: {
		"devtools/no-comment": "error",
		"devtools/no-raw-regexp": "error",
		"devtools/no-try": "off",
		"devtools/no-spread-argument": "warn"
	}
})
