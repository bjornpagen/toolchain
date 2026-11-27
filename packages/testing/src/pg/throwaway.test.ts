import { Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { runsOfIt, runsSeen } from "#pg/throwaway.fixtures.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"

/**
 * A throwaway member's data never outlives its unit, and its templates outlive it: a consumer's runs, two or three, on
 * a throwaway cluster of its own on disk, whose property clones a template whose build counts itself and leaves a
 * database of its own behind. Once each run's member has stopped, its folder is a link naming nothing (the workbench's
 * postgres@ unit took it as it stopped: settle.ts markedThrowaway), its family holds one image, the folder it took
 * (resources/cluster.ts templatesListed), each run's property passed, finding nothing an earlier run left (settle.ts
 * leftoversDropped), and the template was built once in all, every later run's member made from the image (settle.ts
 * seededFromImage). Each case writes the consumer from the checkout's own library (Checkout.dir, so a kill's mutant is
 * in it) and runs it in units of systemd's. Oracle: the specification, over the member's folder and the family's images
 * as the machine holds them, and the build's own count of itself.
 */
export const noMemberOutlivesItsUnit = property.exhaust(runsOfIt, {
	box: "a consumer of a throwaway cluster of its own on disk, whose property clones a template that counts its builds and leaves a database behind, run two or three times",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(runs) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const seen = yield* runsSeen(scratch, library, runs)
				assert.deepEqual(seen, {
					runs: Array.from({ length: runs }, () => ({
						passed: "passed",
						folder: "a link to nothing" as const,
						images: 1
					})),
					builds: 1
				})
			}),
	oracle: {
		kind: "specification",
		name: "a throwaway member's folder goes with its unit, its templates kept as its family's one image, which every later member is made from, its runs' leftovers dropped"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/settle.ts",
			original:
				'\tfamily.cluster.durability === "throwaway"\n\t\t? Effect.flatMap(FileSystem.FileSystem, (fs) =>',
			replacement:
				'\tfamily.cluster.durability === "kept"\n\t\t? Effect.flatMap(FileSystem.FileSystem, (fs) =>',
			why: "A throwaway member left unmarked keeps its folder as its unit stops, every run's data on disk past it; the property fails."
		},
		{
			file: "packages/testing/src/resources/template.ts",
			original: "\t\t\t\tyield* templatesListed(cluster, member)\n\t\t\t\treturn name\n",
			replacement: "\t\t\t\treturn name\n",
			why: "A member that lists none of its templates leaves no image as it stops, so every run builds its templates again; the property fails."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\t\tconst seeded = yield* seededFromImage(family, name, at)\n",
			replacement: "\t\t\tconst seeded = false\n",
			why: "A member made fresh in place of its family's image builds every template again at every run; the property fails."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original:
				"\t\t\tif (seeded) {\n\t\t\t\tyield* leftoversDropped(family, bin, socket, at)\n\t\t\t}\n",
			replacement: "",
			why: "A member made from an image keeps what its runs left, so a member grows by every run's leftovers across runs; the property fails."
		}
	]
})
