import { Effect, Option } from "effect"
import { Digest } from "effect/crypto"
import { assert } from "#assert.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { verdictCacheAt } from "#runner/cache.ts"
import { hashing } from "#runner/closure.fixtures.ts"
import { ModuleSyntax } from "#runner/closure.ts"
import { answeredOf, KEY_SITUATIONS, keyCases, keysOf } from "#runner/keys.fixtures.ts"

/**
 * A kill's cached red answers its next trial exactly when nothing the verdict reads has changed: the property's module
 * and every module it loads, the kill's file and every module that file loads (whether the property's closure holds the
 * file or not: a check that runs it in a child process), the kill's text, the runner config and every module it loads,
 * the runner's entry modules and every module they load, the runtime, and the config's conditions where they resolve a
 * module otherwise (a condition that resolves every module alike changes nothing it reads). A kill whose text
 * loads a module its file does not keys nothing, nor does a runner that is another checkout's, so neither is answered
 * from the cache whatever changed. Each case records the red under its first run's key in a cache of its own and reads
 * it under its second's, both keys made as the kill census makes them. Oracle: the specification, keys.fixtures.ts
 * answeredOf.
 */
export const aCachedRedAnswersOnlyWhatItWasJudgedOn = property.exhaust(keyCases, {
	box: "every place of the kill's file, in the property's closure or outside it, with every change of one input of its verdict, and of nothing it reads",
	needs: { hashing, directory: Scratch.dir },
	situations: KEY_SITUATIONS,
	check:
		({ hashing: services, directory }, c) =>
		(keyCase) =>
			Effect.gen(function* () {
				c.noteAll([keyCase.place, keyCase.change])
				const { syntax, digest } = yield* services
				const root = yield* directory
				const cache = yield* verdictCacheAt(root).pipe(Effect.provideService(Digest.Digest, digest))
				const [first, second] = yield* keysOf(keyCase).pipe(
					Effect.provideService(Digest.Digest, digest),
					Effect.provideService(ModuleSyntax, syntax)
				)
				if (Option.isSome(first)) {
					yield* cache.record(first.value, "passed")
				}
				const answered = Option.isSome(second) && (yield* cache.passed(second.value))
				assert.deepEqual(
					{ case: keyCase, answered },
					{ case: keyCase, answered: answeredOf(keyCase) }
				)
			}),
	oracle: {
		kind: "specification",
		name: "a kill's cached red answers its next trial exactly when nothing the verdict reads changed, and never for a kill whose text loads a new module or a runner of another checkout"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/affected.ts",
			original: "\tEffect.map(jointClosureOf([searched, edited]), (joint): VerdictKey => ({\n",
			replacement: "\tEffect.map(jointClosureOf([searched]), (joint): VerdictKey => ({\n",
			why: "An edit's key holds its file's bytes alone, so a kill of a file the property runs in a child process keeps its red after a module the file loads changes."
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original: "\t\troots: [...input.runner, ...input.modules, ...input.edited]\n",
			replacement: "\t\troots: [...input.runner, ...input.modules]\n",
			why: "No edited file is weighed, so no kill keys a verdict and every cached red is lost."
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original:
				"\t\tEffect.map(jointClosureOf([own, ...shared]), (joint) => [module, joint] as const)\n",
			replacement: "\t\tEffect.map(jointClosureOf([own]), (joint) => [module, joint] as const)\n",
			why: "A module's joint closure leaves out the runner and its config, so a red judged by one runner answers for another."
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original: "\tconst relative = Option.all(within)\n",
			replacement: "\tconst relative = Option.some(Arr.getSomes(within))\n",
			why: "Another checkout's runner is taken as installed, so its verdicts are keyed by no runner at all and one runner's red answers for the next."
		},
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "\t\tArr.every(after, (specifier) => Arr.contains(before, specifier))\n",
			replacement: "\t\ttrue\n",
			why: "A kill whose text loads a module its file does not is keyed, so its red stands after that module changes."
		}
	]
})
