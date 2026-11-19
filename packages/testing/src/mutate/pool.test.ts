/**
 * Where a worker of an image finds a file the runner knows in the checkout (mutate/pool.ts rebasedTo): in the image's
 * root, at the file's path from the checkout, the checkout itself (a package whose root is the repository's, as
 * grizzle's) at the root; a file beside the checkout whose name only starts with the checkout's, or apart from it, where
 * it is.
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { expectedOf, fileOf, pathOf, PLACES, rebasingGen } from "#mutate/pool.fixtures.ts"
import { rebasedTo } from "#mutate/pool.ts"
import { property } from "#property.ts"

export const rebasedFiles = property.explore(rebasingGen, {
	needs: {},
	situations: PLACES,
	check: (_resources, c) => (rebasing) =>
		Effect.sync(() => {
			c.note(rebasing.place)
			assert.deepEqual(
				rebasedTo(pathOf(rebasing.checkout), pathOf(rebasing.root))(pathOf(fileOf(rebasing))),
				expectedOf(rebasing)
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "the file's segments led by the checkout's, replaced by the root's"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutate/pool.ts",
			original: "\t\tif (file === checkout) {\n\t\t\treturn root\n\t\t}\n",
			replacement: "",
			why: "A package whose root is the checkout keeps the checkout's root, so a tree's workers load the checkout's test.config.ts (grizzle's kills of properties that need Checkout.dir)."
		},
		{
			file: "packages/testing/src/mutate/pool.ts",
			original: `Str.startsWith(\`\${checkout}/\`)(file)`,
			replacement: "Str.startsWith(checkout)(file)",
			why: "A file beside the checkout whose name starts with the checkout's is taken into the tree."
		}
	]
})
