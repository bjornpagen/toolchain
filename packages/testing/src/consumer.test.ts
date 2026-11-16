/**
 * The library as a consumer installs it: a package with this library copied into its node_modules runs its tests as
 * Vitest does by default, and the residual table and the watchdog's replay report are what the library's contract says
 * of the consumer's test files. Oracle: stated in the search.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Layer,
	Option,
	type PlatformError,
	Record,
	Stream
} from "effect"
import { ChildProcess } from "effect/process"
import { aimed, explore } from "#explore.ts"
import { required } from "#features.ts"
import { constant, type Gen, int, oneOf } from "#gen.ts"
import manifest from "#package.json" with { type: "json" }
import { replayOf } from "#replay.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { forcedChooser, generate, recorder } from "#source.ts"
import { searched } from "#vitest/searched.ts"

/** This library's checkout: the files a consumer's node_modules holds a copy of. */
const library = `${import.meta.dirname}/..`

/**
 * Where Node finds the installed package `name` from this library's checkout: the first node_modules, from the checkout
 * up, that holds it, whether a package manager installs a package's dependencies beside it or hoists them to the
 * workspace's root.
 */
const installedPackage = (name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const from = (directory: string): Effect.Effect<string, PlatformError.PlatformError> =>
			Effect.flatMap(fs.exists(`${directory}/node_modules/${name}`), (found) =>
				found ? fs.realPath(`${directory}/node_modules/${name}`) : from(`${directory}/..`)
			)
		return yield* from(library)
	})

/**
 * A package that has this library in its node_modules, as a copy of the files its tarball ships, and runs its tests as
 * Vitest does by default, through Vite's module runner: its manifest, its tsconfig, its default config, which names the
 * library's global setup and its residual reporter, and a config of its own for a search that loops. Each case writes
 * its own test files beside them.
 */
const CONSUMER: ReadonlyArray<readonly [path: string, text: string]> = [
	["package.json", `{ "name": "consumer", "private": true, "type": "module" }\n`],
	[
		"tsconfig.json",
		`{ "compilerOptions": { "target": "esnext", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "skipLibCheck": true, "types": [] }, "include": ["src/**/*.ts"] }\n`
	],
	[
		"vitest.config.ts",
		`import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { include: ["src/**/*.test.ts"], globalSetup: ["@bjornpagen/testing/vitest/global-setup"], reporters: ["default", ["@bjornpagen/testing/vitest/reporter", { examples: { kind: "allowed" } }]] } })\n`
	],
	[
		"vitest.loops.config.ts",
		`import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { include: ["src/loops.check.ts"], globalSetup: ["@bjornpagen/testing/vitest/global-setup"] } })\n`
	]
]

/** The consumer's search, which passes, as the default config's run finds it. */
const SEARCHED: readonly [path: string, text: string] = [
	"src/searched.test.ts",
	`import { it } from "@effect/vitest"\nimport { Duration, Effect, Formatter } from "effect"\nimport { drawn, explore } from "@bjornpagen/testing/explore"\nimport { required } from "@bjornpagen/testing/features"\nimport { int } from "@bjornpagen/testing/gen"\nimport { notesOnly } from "@bjornpagen/testing/sense"\nimport { boundedShrink } from "@bjornpagen/testing/shrink"\nimport { searched } from "@bjornpagen/testing/vitest"\nit.effect("a consumer's search", (ctx) =>\n\tsearched(\n\t\tctx,\n\t\texplore(\n\t\t\t{\n\t\t\t\tsuite: "consumer search",\n\t\t\t\toracle: { kind: "universal", name: "a value is its own" },\n\t\t\t\tdraw: drawn(int(0, 9)),\n\t\t\t\tliteral: Formatter.format,\n\t\t\t\tcoverage: required<"small" | "large">(["small", "large"], { cases: 20, sense: notesOnly }),\n\t\t\t\tkept: [],\n\t\t\t\truns: 40,\n\t\t\t\tshrink: boundedShrink(10),\n\t\t\t\tsteerEvery: 8,\n\t\t\t\tcaseHang: Duration.seconds(10)\n\t\t\t},\n\t\t\t(value, c) => Effect.sync(() => c.note(value < 5 ? "small" : "large"))\n\t\t)\n\t)\n)\n`
]

/** The consumer's search that loops on its values from `from` up, its cases' hang limit `hangMillis`. */
const looping = (from: number, hangMillis: number): readonly [path: string, text: string] => [
	"src/loops.check.ts",
	`import { it } from "@effect/vitest"\nimport { Duration, Effect, Formatter } from "effect"\nimport { drawn, explore } from "@bjornpagen/testing/explore"\nimport { noCoverage } from "@bjornpagen/testing/features"\nimport { int } from "@bjornpagen/testing/gen"\nimport { boundedShrink } from "@bjornpagen/testing/shrink"\nimport { searched } from "@bjornpagen/testing/vitest"\nconst loop = () => {\n\tconst cell = new Int32Array(new SharedArrayBuffer(4))\n\twhile (Atomics.load(cell, 0) === 0) {\n\t\tAtomics.add(cell, 0, 0)\n\t}\n}\nit.effect("a consumer's search that loops", (ctx) =>\n\tsearched(\n\t\tctx,\n\t\texplore(\n\t\t\t{\n\t\t\t\tsuite: "consumer loop",\n\t\t\t\toracle: { kind: "universal", name: "a value is its own" },\n\t\t\t\tdraw: drawn(int(0, 9)),\n\t\t\t\tliteral: Formatter.format,\n\t\t\t\tcoverage: noCoverage,\n\t\t\t\tkept: [],\n\t\t\t\truns: 40,\n\t\t\t\tshrink: boundedShrink(10),\n\t\t\t\tsteerEvery: 8,\n\t\t\t\tcaseHang: Duration.millis(${hangMillis})\n\t\t\t},\n\t\t\t(value) => Effect.sync(() => (value >= ${from} ? loop() : undefined))\n\t\t)\n\t)\n)\n`
]

/** The packages a consumer's own files import, each linked to the copy this library resolves. */
const CONSUMER_DEPENDENCIES = ["vitest", "effect", "@effect/vitest"] as const

/** The consumer package of a run of these tests: its directory, removed when the tests end. */
class Consumer extends Context.Service<Consumer, Readonly<{ directory: string }>>()(
	"@bjornpagen/testing/consumer.test/Consumer"
) {}

/**
 * The consumer, built in a temporary directory: its files; the library's package.json, src and scripts copied into its
 * node_modules, beside a link to each dependency the library's manifest declares, so the copy resolves only what the
 * library declares; its own dependencies linked, with each peer the library declares, which the consumer's own copy
 * serves; and the library's bin linked into node_modules/.bin, as a package manager links it.
 */
const consumerLayer = Layer.effect(
	Consumer,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped({ prefix: "bjornpagen-testing-consumer-" })
		const installed = `${directory}/node_modules/@bjornpagen/testing`
		yield* fs.makeDirectory(`${directory}/src`, { recursive: true })
		yield* fs.makeDirectory(installed, { recursive: true })
		yield* fs.makeDirectory(`${directory}/node_modules/@effect`, { recursive: true })
		yield* Effect.forEach(
			CONSUMER,
			([path, text]) => fs.writeFileString(`${directory}/${path}`, text),
			{ discard: true }
		)
		yield* Effect.forEach(
			["package.json", "src", "scripts"],
			(entry) => fs.copy(`${library}/${entry}`, `${installed}/${entry}`),
			{ discard: true }
		)
		yield* fs.makeDirectory(`${installed}/node_modules/@effect`, { recursive: true })
		yield* fs.makeDirectory(`${installed}/node_modules/@bjornpagen`, { recursive: true })
		yield* Effect.forEach(
			Record.keys(manifest.dependencies),
			(name) =>
				Effect.flatMap(installedPackage(name), (real) =>
					fs.symlink(real, `${installed}/node_modules/${name}`)
				),
			{ discard: true }
		)
		yield* Effect.forEach(
			Arr.union(CONSUMER_DEPENDENCIES, Record.keys(manifest.peerDependencies)),
			(name) =>
				Effect.flatMap(installedPackage(name), (real) =>
					fs.symlink(real, `${directory}/node_modules/${name}`)
				),
			{ discard: true }
		)
		return { directory }
	})
)

/** A command run to its end in the consumer's directory: what it printed, and its exit code, none when a signal ended it. */
const ranInConsumer = (command: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const { directory } = yield* Consumer
			const handle = yield* ChildProcess.make(command, args, {
				cwd: directory,
				extendEnv: true,
				stdin: "ignore"
			})
			const [stdout, stderr, exit] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					Effect.exit(handle.exitCode)
				],
				{ concurrency: "unbounded" }
			)
			return {
				stdout,
				stderr,
				exitCode: Exit.isSuccess(exit) ? Option.some(Number(exit.value)) : Option.none()
			}
		})
	)

/** A replay token as the watchdog's report prints it. */
const REPLAY_LINE = regex("TEST_REPLAY='(?<token>[^']*)'")

/** The residual table's line for the consumer's search, indented under the table's heading. */
const CONSUMER_RESIDUAL = regex("^  consumer search: [0-9]+ independent cases", "m")

/** What a case runs in the consumer: Vitest over the consumer's search, which passes, or loops on its values from a threshold up. */
type Run =
	| Readonly<{ kind: "search" }>
	| Readonly<{ kind: "looping search"; from: number; hangMillis: number }>

const loopingRun: Gen<Run> = (source) => ({
	kind: "looping search",
	from: source.draw(int(0, 9)),
	hangMillis: source.draw(int(100, 400))
})

const anyRun: Gen<Run> = oneOf<Run>([constant<Run>({ kind: "search" }), loopingRun])

/** What a case reaches: how a search ended. */
const FEATURES = ["a search tabled", "a search that loops"] as const

type Feature = (typeof FEATURES)[number]

/** A run aimed at a feature, its other choices drawn, for a steered case to reach what is still pending. */
const aimedAt = (feature: Feature): Gen<Run> => {
	switch (feature) {
		case "a search tabled":
			return constant<Run>({ kind: "search" })
		case "a search that loops":
			return loopingRun
	}
}

/** Writes a case's files into the consumer's src, after removing every test file an earlier case left. */
const written = (files: ReadonlyArray<readonly [path: string, text: string]>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const { directory } = yield* Consumer
		const left = yield* fs.readDirectory(`${directory}/src`)
		yield* Effect.forEach(left, (file) => fs.remove(`${directory}/src/${file}`), { discard: true })
		yield* Effect.forEach(
			files,
			([path, text]) => fs.writeFileString(`${directory}/${path}`, text),
			{ discard: true }
		)
	})

/** What a case observes of its run, in the model's terms: how a search's Vitest run ended. */
const observed = (run: Run) =>
	Effect.gen(function* () {
		const { directory } = yield* Consumer
		switch (run.kind) {
			case "search":
			case "looping search": {
				yield* written(run.kind === "search" ? [SEARCHED] : [looping(run.from, run.hangMillis)])
				const ran = yield* ranInConsumer(process.execPath, [
					`${directory}/node_modules/vitest/vitest.mjs`,
					"run",
					...(run.kind === "search"
						? ["src/searched.test.ts"]
						: ["--config", "vitest.loops.config.ts"])
				])
				return {
					exitCode: ran.exitCode,
					tabled: Option.isSome(Option.fromNullishOr(CONSUMER_RESIDUAL.exec(ran.stdout))),
					replay: Option.fromNullishOr(REPLAY_LINE.exec(ran.stderr)?.groups.token)
				}
			}
		}
	})

layer(Layer.provideMerge(consumerLayer, NodeServices.layer))(
	"a package that has the library in its node_modules, its tests on Vite's module runner",
	(it) => {
		it.effect(
			"tables its searches' residual, and has a looping search's process ended with its replay token",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "consumer",
							oracle: {
								kind: "specification",
								name: "the reporter's table and the watchdog's report"
							},
							draw: aimed(
								anyRun,
								Arr.map(FEATURES, (feature) => [feature, aimedAt(feature)] as const)
							),
							literal: Formatter.format,
							coverage: required<Feature>(FEATURES, { cases: 12, sense: notesOnly }),
							kept: [],
							runs: 2,
							shrink: boundedShrink(2),
							steerEvery: 1,
							caseHang: Duration.minutes(5)
						},
						(run, c) =>
							Effect.gen(function* () {
								const seen = yield* observed(run)
								switch (run.kind) {
									case "search":
										c.note("a search tabled")
										deepStrictEqual(
											{ tabled: seen.tabled, exitCode: seen.exitCode },
											{ tabled: true, exitCode: Option.some(0) }
										)
										return
									case "looping search": {
										c.note("a search that loops")
										const token = yield* Option.match(seen.replay, {
											onNone: () => Effect.die("the watchdog's report names no case to replay"),
											onSome: (found) => replayOf(found)
										})
										deepStrictEqual(
											{
												suite: token.suite,
												loops:
													generate(
														recorder(),
														int(0, 9),
														forcedChooser(
															Float64Array.from(token.replayed.values),
															token.replayed.values.length
														)
													).value >= run.from,
												exitCode: seen.exitCode
											},
											{ suite: "consumer loop", loops: true, exitCode: Option.some(1) }
										)
									}
								}
							})
					)
				),
			{ timeout: 1_800_000 }
		)
	}
)
