/**
 * The preset's override type (src/preset.ts ActiveRules), proven by the compiler: an override block that names a rule
 * the preset builds from lists, spelled any way oxlint reads it, fails to typecheck, so no block can narrow the lists
 * on its files, the shared bans with them; a block that names another rule compiles.
 *
 * overridesTyped exhausts its box, every listed rule under every prefix oxlint resolves to it (none, `eslint/`,
 * `typescript/`, `@typescript-eslint/`) beside two rules a block may name, one of them a restricted rule the preset
 * builds from no list, in one program of one `active` call a line, written into a directory of its own and checked by
 * the native compiler against the checkout's preset. Each case's verdict is its own line's errors: one or more where
 * the case is refused, none where it is not.
 *
 * Oracle: the specification, the preset's JSDoc for ActiveRules.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect } from "effect"
import { cells as box, checkedLines, featureOf } from "#preset-types.fixtures.ts"

export const overridesTyped = property.exhaustBatched(finite(box), {
	box: "every rule the preset builds from lists under every prefix oxlint resolves to it, beside two rules a block may name",
	needs: { dir: Scratch.dir, checkout: Checkout.dir },
	situations: ["a listed rule an override names", "a rule an override may name"],
	window: 18,
	batches: 1,
	show: (cell) => cell.rule,
	checkAll:
		({ dir, checkout }) =>
		(cells) =>
			Effect.gen(function* () {
				for (const [cell, c] of cells) {
					c.note(featureOf(cell))
				}
				const scratch = yield* dir
				const tree = yield* checkout
				const erring = yield* checkedLines(
					scratch,
					tree,
					Arr.map(cells, ([cell]) => cell)
				)
				return Arr.map(cells, ([cell], at) =>
					Effect.sync(() => {
						assert.equal(Arr.contains(erring, at), cell.refused)
					})
				)
			}),
	oracle: { kind: "specification", name: "the preset's stated contract for ActiveRules" },
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/preset.ts",
			original: `\tReadonly<Record<\`\${string}\${ListedName}\`, never>>`,
			replacement: `\tReadonly<Record<\`eslint/\${ListedName}\`, never>>`,
			why: "Only the `eslint/` spelling is refused, so `typescript/no-restricted-imports` or the bare name replaces a file's lists, shared bans and all, as alphatest-novus's narrower list did; the other spellings compile and fail."
		},
		{
			file: "packages/devtools/src/preset.ts",
			original: `\tPartial<Record<Rejected, never>> &\n\tReadonly<Record<\`\${string}\${ListedName}\`, never>>`,
			replacement: "\tPartial<Record<Rejected, never>>",
			why: "An override may name the listed rules again; every refused cell compiles and fails."
		}
	]
})
