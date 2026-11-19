import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { boolean, element, finite } from "#gen.ts"
import {
	type ConsumerFiles,
	consumerIn,
	type Layout,
	manifestOf,
	ran
} from "#runner/consumer.fixtures.ts"

/**
 * What the load-check property (loads.test.ts) draws, and the consumer package its check runs `toolchain-test load` in
 * twice: a package holding the library as a workspace link, in a git repository with its lockfile, its runner config
 * including test/*.test.ts, with a module that loads, a module that loads through a fixture module (test/shared.ts,
 * which the include leaves out), and at most one module that throws as it loads; between the two runs the fixture may
 * be changed to throw.
 */

/** How a module can fail to load, or none. */
export type Fault =
	| "none"
	| "a temporal dead zone"
	| "a throwing initializer"
	| "an export that is no property"

/** A case: the module that fails to load, if any, and whether the fixture is changed to throw before the second run. */
export type Package = Readonly<{ fault: Fault; fixtureThrows: boolean }>

/** Every case: each fault and none, the fixture changed or not. */
export const packages = finite((source): Package => ({
	fault: source.draw(
		element([
			"none",
			"a temporal dead zone",
			"a throwing initializer",
			"an export that is no property"
		] as const)
	),
	fixtureThrows: source.draw(boolean)
}))

/** The consumer's layout: the library linked, in git, with its lockfile and TypeScript, so its loads are keyed. */
const layout: Layout = { library: "link", git: true, lockfile: true, typescript: true }

/** A property module's imports and the spec every property of these modules shares; the properties never run. */
const PROLOGUE = Arr.join(
	[
		'import { Effect } from "effect"',
		'import { int } from "@bjornpagen/testing/gen"',
		'import { property } from "@bjornpagen/testing/property"',
		'const spec = { needs: {}, situations: [], check: () => () => Effect.void, oracle: { kind: "specification", name: "never run" }, kept: [], kills: [] } as const',
		""
	],
	"\n"
)

/** The text of the module that fails to load as `fault` says, none for no fault. */
const faultText = (fault: Fault): Option.Option<string> => {
	switch (fault) {
		case "none":
			return Option.none()
		case "a temporal dead zone":
			return Option.some(
				`${PROLOGUE}export const read = property.explore(int(0, size), spec)\nconst size = 9\n`
			)
		case "a throwing initializer":
			return Option.some(
				`${PROLOGUE}const size: number = (() => {\n\tthrow new Error("an initializer throws")\n})()\nexport const thrown = property.explore(int(0, size), spec)\n`
			)
		case "an export that is no property":
			return Option.some(`${PROLOGUE}export const helper = 9\n`)
	}
}

/** What a run says of a module that fails as `fault` says: a part of its message. */
const faultMessage = (fault: Exclude<Fault, "none">): string => {
	switch (fault) {
		case "a temporal dead zone":
			return "Cannot access 'size' before initialization"
		case "a throwing initializer":
			return "an initializer throws"
		case "an export that is no property":
			return "test/fault.test.ts#helper is neither a Property nor a Family"
	}
}

/** The failing module of `drawn`'s package and what its failure says, none when it holds no fault. */
const faultOf = (drawn: Package): Option.Option<readonly [module: string, says: string]> =>
	drawn.fault === "none"
		? Option.none()
		: Option.some(["test/fault.test.ts", faultMessage(drawn.fault)])

/** The module the changed fixture fails, and what its failure says. */
const FIXTURED: readonly [module: string, says: string] = [
	"test/fixtured.test.ts",
	"the fixture throws"
]

/** The fixture as the first run sees it, and as a changed one throws. */
const FIXTURE = "export const shared = 9\n"

const THROWING_FIXTURE = 'throw new Error("the fixture throws")\nexport const shared = 9\n'

/** The consumer's own files for `drawn`, the fixture as the first run sees it. */
const filesOf = (drawn: Package): ConsumerFiles => [
	["package.json", manifestOf(layout)],
	[
		"test.config.ts",
		'import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { Layer } from "effect"\n\nexport default defineRunner({ include: ["test/*.test.ts"], smallStack: [], conditions: [], layer: Layer.empty, mutation: noMutation })\n'
	],
	["test/plain.test.ts", `${PROLOGUE}export const plain = property.explore(int(0, 9), spec)\n`],
	["test/shared.ts", FIXTURE],
	[
		"test/fixtured.test.ts",
		`${PROLOGUE}import { shared } from "./shared.ts"\nexport const fixtured = property.explore(int(0, shared), spec)\n`
	],
	...Option.match(faultText(drawn.fault), {
		onNone: () => [],
		onSome: (text) => [["test/fault.test.ts", text] as const]
	})
]

/** What one `toolchain-test load` run said: its exit code, the modules it failed with their messages, and its counts. */
export type LoadRun = Readonly<{
	exitCode: number
	failed: ReadonlyArray<readonly [module: string, message: string]>
	summary: string
}>

/** The line a run's failure is printed on: `<module>: FAILED TO LOAD: <message>`. */
const FAILED = ": FAILED TO LOAD: "

/** `toolchain-test load` run in the consumer at `directory`, its cache under `cache`, git looking no higher. */
const loadRun = (directory: string, cache: string) =>
	Effect.map(
		ran(
			directory,
			process.execPath,
			["--disable-warning=ExperimentalWarning", "vendor/testing/src/runner/cli-entry.ts", "load"],
			{
				XDG_CACHE_HOME: cache,
				GIT_CEILING_DIRECTORIES: Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/")
			}
		),
		([exitCode, stdout, stderr]): LoadRun => {
			const lines = Arr.filter(Str.split("\n")(`${stdout}${stderr}`), Str.isNonEmpty)
			return {
				exitCode,
				failed: Arr.flatMap(lines, (line) =>
					Option.match(Str.indexOf(FAILED)(line), {
						onNone: () => [],
						onSome: (at) => [[Str.slice(0, at)(line), Str.slice(at + FAILED.length)(line)] as const]
					})
				),
				summary: Option.getOrElse(Arr.last(lines), () => "")
			}
		}
	)

/**
 * Writes the consumer for `drawn` into `directory` from the checkout whose testing package is at `library`, runs
 * `toolchain-test load` there, changes the fixture to throw when `drawn` says so, and runs it again.
 */
export const loadedTwice = (directory: string, library: string, drawn: Package) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const consumer = `${directory}/consumer`
		yield* consumerIn(consumer, layout, library, filesOf(drawn))
		const first = yield* loadRun(consumer, `${directory}/cache`)
		if (drawn.fixtureThrows) {
			yield* fs.writeFileString(`${consumer}/test/shared.ts`, THROWING_FIXTURE)
		}
		const second = yield* loadRun(consumer, `${directory}/cache`)
		return { first, second }
	})

/** A run as the check compares it: its exit code, each failed module and whether it said what it threw, its count. */
export type Compared = Readonly<{
	exitCode: number
	failed: ReadonlyArray<readonly [module: string, said: boolean]>
	summary: string
}>

/**
 * What `toolchain-test load` must say of `drawn`'s package, by the specification: its first run loads every module apart,
 * none cached, and fails the faulty one, naming it with what it threw; its second loads only what has no cached load,
 * the faulty module again (a failure records nothing) and the fixtured module when its fixture now throws, failing
 * each, and takes every other as cached. Each fails the run, exit 1.
 */
export const expectedOf = (drawn: Package, run: "first" | "second"): Compared => {
	const modules = 2 + Option.match(faultOf(drawn), { onNone: () => 0, onSome: () => 1 })
	const failing = [
		...Option.toArray(faultOf(drawn)),
		...(run === "second" && drawn.fixtureThrows ? [FIXTURED] : [])
	]
	const loaded = run === "first" ? modules : failing.length
	return {
		exitCode: failing.length > 0 ? 1 : 0,
		failed: Arr.map(failing, ([module]) => [module, true] as const),
		summary: `${modules} modules: ${loaded} loaded apart, ${modules - loaded} cached, ${failing.length} failed`
	}
}

/** What a run said of `drawn`'s package, as compared: each failure's module, and whether it says what that module threw. */
export const comparedOf = (drawn: Package, run: LoadRun): Compared => ({
	exitCode: run.exitCode,
	failed: Arr.map(run.failed, ([module, message]) => [
		module,
		Arr.some(
			[...Option.toArray(faultOf(drawn)), FIXTURED],
			([failing, says]) => failing === module && Str.includes(says)(message)
		)
	]),
	summary: run.summary
})
