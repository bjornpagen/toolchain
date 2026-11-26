/**
 * `toolchain-test run` answers a property from the verdict cache exactly when nothing its verdict can observe changed:
 * of a consumer's one property run twice, the second run answers it cached when nothing changed between them, or only
 * a variable no worker is given (which the property finds unset); it runs it again when a module it imports, a file of
 * the toolchain no module imports, a variable the runner config gives its workers, or TEST_SEED changed; a property
 * that reads a fixture file at run time, or whose child process reads it, resolves a path or reads a link, is answered
 * cached while what it read stands and runs again once it changed (runner/traces.ts); another checkout of the
 * repository answers from the first's verdicts, its property resolving its own root; one that reads a file's
 * status, which no key holds, runs every time (runner/observe.ts); and one that clones a database template on a
 * cluster of the consumer's own, whose build reads a file, is answered cached while the file stands and runs again once
 * it changed, its connections to its own member keyed by the PostgreSQL serving it, and its family's state kept in the
 * case's own states home, none of it in the account's. Each case
 * writes the consumer from the checkout's own library (Checkout.dir, so a kill's mutant is in it) and runs the runner's
 * own entry in a child process, on one worker. Oracle: the specification, stated per case (reuse.fixtures.ts
 * expectedOf).
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { changes, expectedOf, reusedOf } from "#runner/reuse.fixtures.ts"

export const aRunAnswersFromItsKeyAlone = property.exhaust(changes, {
	box: "a consumer's property run twice, nothing changed between, or a module it imports, a toolchain file no module imports, a variable its workers are given, one they are not, or TEST_SEED; a property that reads a fixture, or whose child reads it, the fixture changed or not; one that resolves a link or reads it, the link changed or not; another checkout's run of one that resolves its root; one that reads a file's status; and one that clones a template of its own cluster whose build reads a file, the file changed or not",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(change) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const second = yield* reusedOf(scratch, library, change)
				assert.deepEqual(second, expectedOf(change))
			}),
	oracle: {
		kind: "specification",
		name: "a run answers a property from the cache exactly when nothing its key or its trace holds changed and it observed nothing past both; a variable no worker is given never reaches one"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "\t\t\t\t\t\t([worker, upTo]): WorkerReads => ({ reads: worker.traces, upTo })\n",
			replacement: "\t\t\t\t\t\t([worker]): WorkerReads => ({ reads: worker.traces, upTo: 0 })\n",
			why: "A pass keeps no trace of what it read, so a property that reads a fixture at run time is answered from the cache after the fixture changed; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original: "\t\t\t\tfor (const one of acts.reads) {\n",
			replacement: "\t\t\t\tfor (const one of acts.reads.slice(0, 0)) {\n",
			why: "A child's reads are kept from its property's trace, so a property whose child reads a fixture is answered from the cache after the fixture changed; the property fails."
		},
		{
			file: "packages/testing/src/runner/grounds.ts",
			original: "\t\tconst toolchain = yield* toolchainDigest\n",
			replacement: "\t\tconst toolchain = yield* environmentDigestOf(config)\n",
			why: "The key holds no digest of the toolchain, so a run of a toolchain moved since answers from a verdict an older toolchain judged; the property fails."
		},
		{
			file: "packages/testing/src/runner/grounds.ts",
			original: "\t\tconst environment = yield* environmentDigestOf(config)\n",
			replacement: "\t\tconst environment = yield* toolchainDigest\n",
			why: "The key holds no digest of its workers' environment, so a run whose workers are given another value answers from a verdict judged under the first; the property fails."
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original:
				'\t\tconst seed = seeding.kind === "given" ? seeding.seed : yield* derivedSeedOf(unseeded)\n',
			replacement: "\t\tconst seed = yield* derivedSeedOf(unseeded)\n",
			why: "A key ignores TEST_SEED, so a run told to draw another rotating stream answers from the verdict of the key's own; the property fails."
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original: "\t\t(ran) => Option.isNone(ran.observed.unclean)\n",
			replacement: "\t\t(ran) => Option.isNone(ran.observed.unclean) || true\n",
			why: "A property that observed past its key is kept as a pass, so a run answers from the cache a property that reads a file's status, which no key holds; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original:
				'const FS_ACTS: ReadonlyArray<readonly [name: string, act: Act]> = [\n\t["readFile", "reads"],\n',
			replacement: "const FS_ACTS: ReadonlyArray<readonly [name: string, act: Act]> = [\n",
			why: "The guard neither traces nor sees node:fs's readFile, so a property that reads a fixture at run time is answered from the cache after the fixture changed; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original: '\tfor (const call of ["spawnSync", "execFileSync"] as const) {\n',
			replacement: '\tfor (const call of ["execFileSync"] as const) {\n',
			why: "The guard neither traces nor sees spawnSync, so a property whose child reads a fixture is answered from the cache after the fixture changed; the property fails."
		},
		{
			file: "packages/testing/src/resources/cluster.ts",
			original:
				"\t\t\t\t\t\t\t\t\t\t\t\t(member) => Effect.sync(() => guardServers(serverAddressesOf(member)))\n",
			replacement: "\t\t\t\t\t\t\t\t\t\t\t\t(member) => Effect.sync(() => guardServers([]))\n",
			why: "The guard is told none of the run's own members, so a property's connection to its own cluster is an observation past every key, and a database property runs every time; the property whose template's build file stands is not answered, and the property fails."
		},
		{
			file: "packages/testing/src/resources/template.ts",
			original: "\t\t\tEffect.scoped(template.build({ member, name: building }))\n",
			replacement:
				"\t\t\tasInfrastructure(Effect.scoped(template.build({ member, name: building })))\n",
			why: "A template's build is the runner's own work, so nothing it reads reaches its template or the trace of the property that built it; the property is answered after the file its template's build reads changed, and the property fails."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original:
				'\tXDG_STATE_HOME: process.getBuiltinModule("node:path").dirname(family.homes.states)\n',
			replacement: "",
			why: "A settle unit takes the manager's environment for its states home, the account's, so a run whose states home is its own has its family's state written outside it: the consumer's run finds its family unsettled and its settle's state is left in the account's states home; the property fails."
		},
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "\t\t\t\tenv: childEnvironmentOf(spec.env, compiling),\n",
			replacement: "\t\t\t\tenv: childEnvironmentOf({ ...process.env, ...spec.env }, compiling),\n",
			why: "A worker is given the runner's whole environment, so a variable no key holds reaches the property; the property fails."
		}
	]
})
