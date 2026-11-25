import { defineConfig } from "oxlint"
import { standard } from "#preset.ts"

const { lintConfig } = standard({
	rejected: { rules: {}, diagnostics: {} },
	exceptions: [],
	effectFree: [],
	packs: {},
	bannedPackages: []
})

/** A configuration the preset's standard builds, for a repository of the core alone. */
export default defineConfig(
	lintConfig({
		ignorePatterns: [],
		restrictedImports: { paths: [], patterns: [] },
		restrictedGlobals: [],
		restrictedProperties: [],
		restrictions: [],
		unassignedImports: [],
		environment: { library: [], readers: [] },
		ceremony: [],
		plugin: {
			"bearer-owners": { owners: [] },
			"brands-sole-mint": { mints: [] },
			"import-doors": { doors: [] },
			"no-case-list": { searches: [], draws: [], mints: [], cases: [], dictionaries: [] },
			"no-dynamic-imports": { allowed: [] },
			"no-raw-sql": { sources: [], writers: [] },
			"no-spread-argument": { tuples: [] }
		},
		ownPlugins: [],
		tests: { library: "none" },
		overrides: []
	})
)
