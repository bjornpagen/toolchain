import { defineConfig } from "oxlint"

/** A configuration that names the dev tools' plugin and the core rules by hand, as they stood before the toolchain added
 * no-variadic-callback. */
export default defineConfig({
	jsPlugins: ["../../../oxlint-plugin.ts"],
	rules: {
		"devtools/bearer-owners": ["error", { owners: [] }],
		"devtools/brands-sole-mint": ["error", { mints: [] }],
		"devtools/import-doors": ["error", { doors: [] }],
		"devtools/no-case-list": ["error", { searches: [], draws: [], mints: [], cases: [], dictionaries: [] }],
		"devtools/no-comment": "error",
		"devtools/no-default-parameter": "error",
		"devtools/no-dynamic-imports": ["error", { allowed: [] }],
		"devtools/no-inline-suppression": "error",
		"devtools/no-module-state": "error",
		"devtools/no-null-undefined-union": "error",
		"devtools/no-option-bridge": "error",
		"devtools/no-optional-parameter": "error",
		"devtools/no-overload": "error",
		"devtools/no-plant": "error",
		"devtools/no-pointless-type-alias": "error",
		"devtools/no-raw-regexp": "error",
		"devtools/no-raw-sql": ["error", { sources: [], writers: [] }],
		"devtools/no-spread-argument": ["error", { tuples: [] }],
		"devtools/no-switch-default-bailout": "error",
		"devtools/no-useless-continue": "error",
		"devtools/prefer-early-return": "error",
		"devtools/sha256-digests": "error"
	}
})
