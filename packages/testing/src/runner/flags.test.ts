/**
 * The flags a command runs under (runner/load.ts requiredFlagsAt, which toolchain-test's entry reads before any
 * command): in a package that states no runner config, the hardened flags alone, so a census of Vitest modules judged
 * as foreign commands runs there (den-vercel's refused with "test.config.ts did not load" before any of its work); in
 * one whose config states export conditions, the hardened flags and a `--conditions` flag each, in their order; and a
 * config that is there but throws as it loads fails, naming the config. Each case writes its package into a directory
 * of its own (flags.fixtures.ts) and reads it in this process. Oracle: the specification, stated per package.
 */
import { Array as Arr, Effect, Option, Result } from "effect"
import { assert } from "#assert.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { CONDITIONS, statings, writtenPackage } from "#runner/flags.fixtures.ts"
import { requiredFlagsAt } from "#runner/load.ts"

export const flagsFromTheStatedConfig = property.exhaust(statings, {
	box: "a package stating no runner config, one whose config states two export conditions, and one whose config throws as it loads",
	needs: { directory: Scratch.dir },
	situations: [],
	check:
		({ directory }) =>
		(stated) =>
			Effect.gen(function* () {
				const root = yield* directory
				yield* writtenPackage(root, stated)
				const flags = yield* Effect.result(requiredFlagsAt(root))
				switch (stated) {
					case "none":
						assert.deepEqual(Result.getSuccess(flags), Option.some(HARDENED_FLAGS))
						return
					case "conditions":
						assert.deepEqual(
							Result.getSuccess(flags),
							Option.some([
								...HARDENED_FLAGS,
								...Arr.map(CONDITIONS, (condition) => `--conditions=${condition}`)
							])
						)
						return
					case "broken":
						assert.deepEqual(
							Option.map(Result.getFailure(flags), (failed) => failed.path),
							Option.some("test.config.ts")
						)
				}
			}),
	oracle: {
		kind: "specification",
		name: "no config, the hardened flags; a config's conditions, a flag each after them; a config that throws, refused naming it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/load.ts",
			original: "return stated ? yield* Effect.asSome(configOf(root)) : Option.none()",
			replacement: "return yield* Effect.asSome(configOf(root))",
			why: "A package that states no runner config is read as one whose config does not load, so toolchain-test refuses every command there before it starts, a census of its Vitest modules among them (den-vercel's, 2026-11-20); the property fails."
		},
		{
			file: "packages/testing/src/runner/load.ts",
			original: `onSome: (config) => Arr.map(config.conditions, (condition) => \`--conditions=\${condition}\`)`,
			replacement: "onSome: () => []",
			why: "A config's export conditions are dropped from the flags, so a command runs its modules under none of the conditions the package resolves by; the property fails."
		}
	]
})
