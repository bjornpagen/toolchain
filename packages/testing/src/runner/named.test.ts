/**
 * A command's arguments name properties of its package (runner/run.ts loadPackage), each a module, a directory of
 * them or a property identity: none names every property its runner config includes; an argument that names none, a
 * module the include leaves out, an included module exporting no property, or an identity its module does not export,
 * fails the load with a LoadFailed naming each such argument and why, where the run passed with no property; and
 * arguments that all name properties load exactly those, in discovery order. Each case writes the scratch package of
 * named.fixtures.ts into its own directory and loads it in this process. Oracle: the specification, stated per
 * argument in the roster.
 */
import { Array as Arr, Effect } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import {
	expectedOf,
	loadedOf,
	selections,
	situationsOf,
	writtenPackage
} from "#runner/named.fixtures.ts"
import { loadPackage } from "#runner/run.ts"

export const namedArguments = property.explore(selections, {
	needs: { directory: Scratch.dir },
	situations: [
		"no argument, every property",
		"every argument names a property",
		"an argument not in the include",
		"an included module exporting no property",
		"an identity its module does not export",
		"an argument naming none beside one naming some"
	],
	check:
		({ directory }, c) =>
		(selection) =>
			Effect.gen(function* () {
				c.noteAll(situationsOf(selection))
				const root = yield* directory
				yield* writtenPackage(root)
				const loaded = yield* Effect.result(
					Effect.map(
						loadPackage(
							root,
							Arr.map(selection, (named) => named.text)
						),
						(package_) => package_.discovered
					)
				)
				deepStrictEqual(loadedOf(loaded), expectedOf(selection))
			}),
	oracle: {
		kind: "specification",
		name: "no argument loads every included property; an argument naming no property is refused, naming it and why; named arguments load exactly what they name"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/run.ts",
			original: "		if (Arr.isReadonlyArrayNonEmpty(unnamed)) {\n",
			replacement: "		if (Arr.isReadonlyArrayNonEmpty(unnamed) && unnamed.length < 0) {\n",
			why: "An argument that names no property is passed over, so a run of a module the include leaves out, or of a property its module does not export, passes with no property, as finding 60's pg run did; the property fails."
		},
		{
			file: "packages/testing/src/runner/run.ts",
			original: "				!Arr.some(included, (module) => reaches(argument, module))\n",
			replacement: "				Arr.some(included, (module) => !reaches(argument, module))\n",
			why: "An argument's refusal says why wrongly, a module the include leaves out read as exporting no property and an included one as left out; the property fails."
		}
	]
})
