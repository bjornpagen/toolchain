/**
 * The preset's lists (src/preset.ts): every file is held to the shared bans whatever lists a project passes, zod among
 * them, and a restriction only adds to what the file is held to.
 *
 * listsHeld searches projects drawn from a grammar of the contract (preset.fixtures.ts): a root's lists, none of them
 * zod; restrictions over directories and files of a small tree, each list stated or not; the library, its readers and
 * the Effect-free code over the same tree; and one file of it. The lists oxlint holds the file to, read from the built
 * configuration as oxlint reads one, must be the shared bans (the banned packages by pattern, so `zod/v3` with `zod`,
 * the relative-import ban, Effect's metrics and the platform's index, Temporal), the root's lists, the environment bans
 * in the library outside its readers, Math.random's in Effect-free code, and the lists of the last restriction naming
 * the file, whole.
 *
 * Oracle: the specification, the preset's JSDoc for its lists and restrictions, over the environment's exported lists.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { cases, configOf, expectedOf, featuresOf, resolvedOf } from "#preset.fixtures.ts"

/** Hold each case's file to exactly the lists the contract gives it. */
export const listsHeld = property.explore(cases, {
	needs: {},
	situations: [
		"a file no restriction names",
		"a restriction's imports on its file",
		"a later restriction's list over an earlier one's",
		"a later restriction of an empty list",
		"a restriction over a directory above the library",
		"a restricted file in the library",
		"a restricted reader",
		"a restricted file in Effect-free code"
	],
	check: (_resources, c) => (drawn) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(drawn))
			assert.deepEqual(resolvedOf(configOf(drawn), drawn.file), expectedOf(drawn))
		}),
	oracle: {
		kind: "specification",
		name: "the preset's stated contract for its lists and restrictions over the environment's exported lists"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/preset.ts",
			original:
				"\t\tpatterns: [...lists.patterns, ...Arr.map(banned, bannedImportOf), RELATIVE_IMPORTS]",
			replacement: "\t\tpatterns: [...lists.patterns, RELATIVE_IMPORTS]",
			why: "Zod is a project's to ban, as it was: a project whose lists leave it out lets every file import zod; every case fails."
		},
		{
			file: "packages/devtools/src/preset.ts",
			original: `\tgroup: [banned.name, \`\${banned.name}/**\`],`,
			replacement: "\tgroup: [banned.name],",
			why: "The ban names zod's path alone, so `zod/v3` passes it, as it passed alphatest-novus's; every case fails."
		},
		{
			file: "packages/devtools/src/preset.ts",
			original: "\t\t\t\t\t\t\t...project.restrictedImports.paths,",
			replacement: "",
			why: "A block's imports drop the root's paths, as alphatest-novus's narrower list dropped its zod ban; the cases with root paths fail."
		},
		{
			file: "packages/devtools/src/preset.ts",
			original: "\t\t\t\tArr.flatMap([{ areas, region: PLAIN }, ...places], (place) =>",
			replacement: "\t\t\t\tArr.flatMap([{ areas, region: PLAIN }], (place) =>",
			why: "A restriction over the library drops the environment bans on the files it names, and over Effect-free code Math.random's; the restricted files in the library and in Effect-free code fail."
		}
	]
})
