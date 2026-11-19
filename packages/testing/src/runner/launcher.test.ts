/**
 * The launcher (scripts/toolchain-test.sh) starts the runner's command under every hardened flag the runner requires
 * (runner/config.ts HARDENED_FLAGS), so cli.ts never starts a second node to add them (main's measure: about 1.2 CPU-s
 * and 0.85 s of wall an invocation). The script lists them in shell, so this property holds the list to the runner's.
 * Oracle: stated in the property.
 */
import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { assert } from "#assert.ts"
import { finite, int } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { launcherFlagsOf } from "#runner/launcher.fixtures.ts"

export const launcherHardened = property.exhaust(finite(int(0, HARDENED_FLAGS.length - 1)), {
	box: "every hardened flag the runner requires",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(at) =>
			Effect.gen(function* () {
				const flag = Arr.getUnsafe(HARDENED_FLAGS, at)
				const fs = yield* FileSystem.FileSystem
				const script = yield* fs.readFileString(`${yield* checkout}/scripts/toolchain-test.sh`)
				assert.equal(Str.includes(` ${flag} `)(` ${launcherFlagsOf(script)} `), true)
			}),
	oracle: {
		kind: "specification",
		name: "the launcher passes every hardened flag the runner requires"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/scripts/toolchain-test.sh",
			original: ' --unhandled-rejections=strict"',
			replacement: '"',
			why: "The launcher leaves a hardened flag out, so cli.ts starts a second node to add it on every invocation, as before; this property fails."
		}
	]
})
