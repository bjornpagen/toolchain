import { Array as Arr, Effect, FileSystem } from "effect"
import { element, finite } from "#gen.ts"
import { UNRUN_BUDGET } from "#runner/budgets.fixtures.ts"

/**
 * What the flags property (flags.test.ts) draws and writes: a package stating no runner config, one whose config states
 * two export conditions, and one whose config throws as it loads.
 */

/** How a drawn package states its runner config. */
export type Stated = "none" | "conditions" | "broken"

/** Every way a package states its config, each drawn once. */
export const statings = finite((source) =>
	source.draw(element(["none", "conditions", "broken"] as const))
)

/** The conditions the stating package's config names, in its order. */
export const CONDITIONS: ReadonlyArray<string> = ["flags-test-first", "flags-test-second"]

/** The runner config text of a package stating it: its two export conditions, or a load that throws. */
const configText = (stated: Exclude<Stated, "none">): string => {
	switch (stated) {
		case "broken":
			return 'throw new Error("this config throws as it loads")\n'
		case "conditions":
			return Arr.join(
				[
					`import { Layer } from "${import.meta.resolve("effect")}"`,
					`import { defineRunner, noMutation } from "${import.meta.resolve("#runner/config.ts")}"`,
					`export default defineRunner({ budget: { kind: "cpu", millis: ${String(UNRUN_BUDGET)} }, include: ["test/*.test.ts"], smallStack: [], conditions: [${Arr.join(
						Arr.map(CONDITIONS, (condition) => `"${condition}"`),
						", "
					)}], layer: Layer.empty, mutation: noMutation })`,
					""
				],
				"\n"
			)
	}
}

/** Writes the package `stated` draws into `root`: a test.config.ts, or nothing. */
export const writtenPackage = (root: string, stated: Stated) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		if (stated !== "none") {
			yield* fs.writeFileString(`${root}/test.config.ts`, configText(stated))
		}
	})
