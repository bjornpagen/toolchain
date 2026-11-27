import { defineConfig } from "oxlint"

/** A configuration that loads the dev tools' plugin under a name of its own (oxlint's `{ name, specifier }` entry) beside
 * a plugin named by its package alone (an entry of text), and holds two core rules at error. */
export default defineConfig({
	jsPlugins: [
		{ name: "devtools", specifier: "../../../oxlint-plugin.ts" },
		"eslint-plugin-better-tailwindcss"
	],
	rules: {
		"devtools/no-comment": "error",
		"devtools/no-raw-regexp": "error"
	}
})
