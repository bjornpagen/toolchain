/**
 * A tool a turbo task runs that enables Node's compile cache naming no directory keeps it in the toolchain's compile
 * cache, on disk under toolchain-test's cache, never under os.tmpdir() (turbo.ts, testing's runner/compile-cache.ts):
 * toolchain-turbo hands every task NODE_COMPILE_CACHE, which Node takes before os.tmpdir(), a tmpfs of bounded inodes
 * on a machine like cassowary (main, 2026-11-20: /tmp out of inodes, 435,000 of them node-compile-cache entries), and
 * which it sets whatever its caller's environment names. The case runs toolchain-turbo from the checkout with its own
 * TMPDIR and XDG_CACHE_HOME, and a NODE_COMPILE_CACHE under that TMPDIR or none, turbo a stub whose task enables the
 * cache as vite's command does and writes down the directory Node took. Oracle: the specification, Node's
 * documentation of module.enableCompileCache (NODE_COMPILE_CACHE, else os.tmpdir()/node-compile-cache).
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { boolean, finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect, String as Str } from "effect"
import { compileCacheOf } from "#compile-cache.fixtures.ts"

export const compileCacheOnDisk = property.exhaust(finite(boolean), {
	box: "a turbo run of one task that enables Node's compile cache naming no directory, its caller naming a compile cache under its TMPDIR or none",
	needs: { dir: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ dir, checkout }) =>
		(inherited) =>
			Effect.gen(function* () {
				const directory = yield* dir
				const root = yield* checkout
				const run = yield* compileCacheOf(root, directory, inherited)
				assert.deepEqual(
					{
						status: run.status,
						inTheCache: Str.startsWith(`${run.cache}/toolchain-test/compile`)(run.took),
						underTmp: Str.startsWith(run.tmp)(run.took)
					},
					{ status: 0, inTheCache: true, underTmp: false }
				)
			}),
	oracle: {
		kind: "specification",
		name: "a task's tool that enables Node's compile cache naming no directory takes NODE_COMPILE_CACHE, which toolchain-turbo sets to the toolchain's compile cache, before os.tmpdir()"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/turbo.ts",
			original: `env: { TURBO_CONCURRENCY: \`\${width}\`, NODE_COMPILE_CACHE: compiled },`,
			replacement: `env: { TURBO_CONCURRENCY: \`\${width}\` },`,
			why: "toolchain-turbo hands its tasks no compile cache, as before, so a tool a task runs that enables Node's compile cache naming no directory keeps it under os.tmpdir(), the tmpfs whose inodes ran out on cassowary (435,000 node-compile-cache entries); the property fails, the cache under the run's TMPDIR."
		}
	]
})
