import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	type PlatformError,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { boolean, element, type FiniteSpace, finite } from "#gen.ts"

/**
 * Consumer packages for consumer.test.ts: a tiny package with two passing properties, one of them with a kill that
 * survives, laid out as a repository holds the library (a workspace link to the library's files in the repository, as
 * grizzle's vendor/toolchain; or installed under node_modules), in a git repository or not, with a lockfile or not,
 * with TypeScript installed or not. Each is written in a scratch directory from this checkout's own library files, and
 * run in a child process through the library's run keying (affected.ts runKeyingAt, where the closure hasher loads),
 * its loadPackage and its inline evaluator, so the run is the one `toolchain-test run` does, with no pool nested in
 * the case.
 */

/**
 * How a consumer holds the library, whether it lies in a git repository and has a lockfile, and whether TypeScript, the
 * closure hasher's optional peer, is installed.
 */
export type Layout = Readonly<{
	library: "link" | "installed"
	git: boolean
	lockfile: boolean
	typescript: boolean
}>

/** Every layout: the library linked or installed, in git or not, with a lockfile or not, with TypeScript or not. */
export const layouts: FiniteSpace<Layout> = finite((source) => ({
	library: source.draw(element(["link", "installed"])),
	git: source.draw(boolean),
	lockfile: source.draw(boolean),
	typescript: source.draw(boolean)
}))

/**
 * Whether a layout's properties have their verdicts recorded: it lies in a git repository, the closure hasher loads, and
 * a lockfile keys the closures.
 */
export const keyed = (layout: Layout): boolean => layout.git && layout.typescript && layout.lockfile

/** What a layout exercises. */
export type LayoutSituation =
	| "a workspace link with a verdict key"
	| "an installed library with a verdict key"
	| "a package in no git repository"
	| "a package with no lockfile"
	| "a package with no TypeScript"

/** The situations a layout reaches. */
export const layoutSituationsOf = (layout: Layout): ReadonlyArray<LayoutSituation> => [
	...(keyed(layout)
		? [
				layout.library === "link"
					? ("a workspace link with a verdict key" as const)
					: ("an installed library with a verdict key" as const)
			]
		: []),
	...(layout.git ? [] : ["a package in no git repository" as const]),
	...(layout.lockfile ? [] : ["a package with no lockfile" as const]),
	...(layout.typescript ? [] : ["a package with no TypeScript" as const])
]

/** The repository a package of it lies in: the toolchain's root, two directories above packages/<name>. */
const repositoryOf = (packageDirectory: string): string =>
	Arr.join(Arr.dropRight(Str.split("/")(packageDirectory), 2), "/")

/** The library's packages a consumer holds, by their directory under packages/. */
const LIBRARY = ["testing"] as const

/** Copies every file under `from` into `to`, node_modules aside. */
const copied = (
	from: string,
	to: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.makeDirectory(to, { recursive: true })
		for (const name of yield* fs.readDirectory(from)) {
			if (name === "node_modules") {
				continue
			}
			const info = yield* fs.stat(`${from}/${name}`)
			if (info.type === "Directory") {
				yield* copied(`${from}/${name}`, `${to}/${name}`)
			} else {
				yield* fs.copyFile(`${from}/${name}`, `${to}/${name}`)
			}
		}
	})

/** The consumer's own importer in its lockfile: the library as its layout holds it, and effect. */
const importerOf = (layout: Layout): string =>
	Arr.join(
		[
			"  .:",
			"    dependencies:",
			"      '@bjornpagen/testing':",
			`        specifier: ${layout.library === "link" ? "link:vendor/testing" : "file:testing.tgz"}`,
			`        version: ${layout.library === "link" ? "link:vendor/testing" : "file:testing.tgz"}`,
			"      effect:",
			"        specifier: 4.1.4",
			"        version: 4.1.4",
			""
		],
		"\n"
	)

/**
 * The consumer's lockfile, from this checkout's: the library's importers renamed to where a workspace link keeps them
 * (vendor/<package>), the root's importer the consumer's, and for an installed library its package entry by its
 * tarball.
 */
const lockfileOf = (text: string, layout: Layout): string => {
	const [first, ...rest] = Str.split("\n---\n")(text)
	const lines = Str.split("\n")(Arr.join(rest, "\n---\n"))
	const importers = Arr.findFirstIndex(lines, (line) => line === "importers:")
	const own = Option.flatMap(importers, (at) =>
		Option.map(
			Arr.findFirstIndex(Arr.drop(lines, at), (line) => line === "  .:"),
			(offset) => at + offset
		)
	)
	const ownEnd = Option.flatMap(own, (at) =>
		Option.map(
			Arr.findFirstIndex(
				Arr.drop(lines, at + 1),
				(line) => Str.startsWith("  ")(line) && !Str.startsWith("   ")(line)
			),
			(offset) => at + 1 + offset
		)
	)
	const replaced = Option.match(Option.all([own, ownEnd]), {
		onNone: () => lines,
		onSome: ([start, end]) => [
			...Arr.take(lines, start),
			...Str.split("\n")(importerOf(layout)),
			...Arr.drop(lines, end)
		]
	})
	const renamed = Arr.map(replaced, (line) =>
		Arr.reduce(LIBRARY, line, (now, name) =>
			now === `  packages/${name}:` || now === `  packages/${name}: {}`
				? `  vendor/${Str.slice(`  packages/`.length)(now)}`
				: now
		)
	)
	const installed =
		layout.library === "installed"
			? Arr.flatMap(renamed, (line) =>
					line === "packages:"
						? [
								line,
								"",
								"  '@bjornpagen/testing@file:testing.tgz':",
								"    resolution: {integrity: sha512-consumer, tarball: 'file:testing.tgz'}"
							]
						: [line]
				)
			: renamed
	const snapshots =
		layout.library === "installed"
			? [...installed, "  '@bjornpagen/testing@file:testing.tgz': {}", ""]
			: installed
	return `${first}\n---\n${Arr.join(snapshots, "\n")}`
}

/** A consumer's own files, each its path from the consumer's root and its text. */
export type ConsumerFiles = ReadonlyArray<readonly [path: string, text: string]>

/** A consumer's manifest: the library as its layout holds it, and effect. */
export const manifestOf = (layout: Layout): string =>
	`{ "name": "consumer", "version": "0.0.0", "private": true, "type": "module", "dependencies": { "@bjornpagen/testing": "${layout.library === "link" ? "link:vendor/testing" : "file:testing.tgz"}", "effect": "4.1.4" } }\n`

/**
 * The consumer's files: its manifest, runner config, a passing property, a passing property whose kill survives (its
 * replacement is the same product), and the script that runs them inline.
 */
export const runnerFilesOf = (layout: Layout): ConsumerFiles => {
	const library =
		layout.library === "link" ? "./vendor/testing" : "./node_modules/@bjornpagen/testing"
	return [
		["package.json", manifestOf(layout)],
		[
			"test.config.ts",
			`import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { Layer } from "effect"\n\nexport default defineRunner({ include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: [], layer: Layer.empty, mutation: noMutation })\n`
		],
		[
			"test/sums.test.ts",
			`import { Effect } from "effect"\nimport { int } from "@bjornpagen/testing/gen"\nimport { property } from "@bjornpagen/testing/property"\n\nexport const sums = property.explore(int(0, 9), {\n\tneeds: {},\n\tsituations: [],\n\tcheck: () => (a) => (a + (9 - a) === 9 ? Effect.void : Effect.die("not nine")),\n\toracle: { kind: "specification", name: "a + (9 - a) is 9" },\n\tkept: [],\n\tkills: []\n})\n`
		],
		[
			"test/survived.test.ts",
			`import { Effect } from "effect"\nimport { int } from "@bjornpagen/testing/gen"\nimport { property } from "@bjornpagen/testing/property"\n\nexport const survived = property.explore(int(0, 9), {\n\tneeds: {},\n\tsituations: [],\n\tcheck: () => (a) => (a * 0 === 0 ? Effect.void : Effect.die("not zero")),\n\toracle: { kind: "specification", name: "a * 0 is 0" },\n\tkept: [],\n\tkills: [{ file: "test/survived.test.ts", original: "a * 0 === 0", replacement: "0 * a === 0", why: "a kill that survives, which the kill census refuses and no run judges" }]\n})\n`
		],
		[
			"run-inline.mjs",
			`import * as NodeServices from "@effect/platform-node/NodeServices"\nimport { Effect, Option, Result } from "effect"\nimport { inlineRun, searchInline } from "${library}/src/runner/inline.ts"\nimport { emptyOutcome, loadPackage } from "${library}/src/runner/run.ts"\nimport { affectedModule } from "${library}/src/runner/settle.ts"\n\nconst root = process.cwd()\nconst program = Effect.gen(function* () {\n\tconst keying = yield* Effect.flatMap(Effect.result(affectedModule), Result.match({ onSuccess: (module) => module.runKeyingAt(root, [], { kind: "given", seed: 1 }), onFailure: (unloaded) => Effect.succeed({ kind: "unkeyed", why: unloaded.message }) }))\n\tif (keying.kind === "unkeyed") {\n\t\tprocess.stdout.write(\`verdicts not read or recorded: \${keying.why}\\n\`)\n\t}\n\tconst { discovered } = yield* loadPackage(root, [])\n\tconst properties = yield* Effect.forEach(discovered, (found) =>\n\t\tEffect.map(Effect.scoped(searchInline(found.property, inlineRun(found.id, 1))), (verdict) => ({ id: found.id, stack: "default", label: found.id, module: found.module, kind: found.property.kind, oracle: found.property.oracle, verdict, millis: 0, observed: { unclean: Option.none(), traces: [], own: Option.none(), readBy: "none" } }))\n\t)\n\tif (keying.kind === "keyed") {\n\t\tyield* keying.record({ ...emptyOutcome, properties })\n\t}\n\tprocess.stdout.write(JSON.stringify({ verdicts: properties.map((ran) => ran.verdict.kind) }) + "\\n")\n})\nEffect.runPromise(Effect.scoped(program).pipe(Effect.provide(NodeServices.layer))).catch((cause) => {\n\tconsole.error(cause)\n\tprocess.exitCode = 1\n})\n`
		]
	]
}

/**
 * Writes a consumer of `layout` into `directory` from the checkout whose testing package is at `packageDirectory`
 * (Checkout.dir, so a mutant the mutator writes into a worker tree is in the library the consumer holds): its `files`;
 * the library's packages, linked from vendor/ or installed as files under node_modules/@bjornpagen; every other package
 * of the checkout's node_modules linked in, TypeScript's only when it has TypeScript; its lockfile when it has one; and
 * a git repository when it lies in one.
 */
export const consumerIn = Effect.fn("consumerIn")(function* (
	directory: string,
	layout: Layout,
	packageDirectory: string,
	files: ConsumerFiles
) {
	const fs = yield* FileSystem.FileSystem
	const checkout = repositoryOf(packageDirectory)
	for (const [path, text] of files) {
		yield* fs.makeDirectory(
			Arr.join(Arr.initNonEmpty(Str.split("/")(`${directory}/${path}`)), "/"),
			{
				recursive: true
			}
		)
		yield* fs.writeFileString(`${directory}/${path}`, text)
	}
	yield* fs.makeDirectory(`${directory}/node_modules/@bjornpagen`, { recursive: true })
	for (const name of LIBRARY) {
		const held = `${directory}/${layout.library === "link" ? `vendor/${name}` : `node_modules/@bjornpagen/${name}`}`
		yield* fs.makeDirectory(held, { recursive: true })
		yield* fs.copyFile(`${checkout}/packages/${name}/package.json`, `${held}/package.json`)
		yield* copied(`${checkout}/packages/${name}/src`, `${held}/src`)
		if (layout.library === "link") {
			yield* fs.symlink(`../../vendor/${name}`, `${directory}/node_modules/@bjornpagen/${name}`)
		}
	}
	for (const name of yield* fs.readDirectory(`${checkout}/node_modules`)) {
		if (
			name !== "@bjornpagen" &&
			!Str.startsWith(".")(name) &&
			(layout.typescript || (name !== "typescript" && name !== "@typescript"))
		) {
			yield* fs.symlink(`${checkout}/node_modules/${name}`, `${directory}/node_modules/${name}`)
		}
	}
	if (layout.lockfile) {
		const text = yield* fs.readFileString(`${checkout}/pnpm-lock.yaml`)
		yield* fs.writeFileString(`${directory}/pnpm-lock.yaml`, lockfileOf(text, layout))
	}
	if (layout.git) {
		yield* ran(directory, "git", ["init", "-q"], {})
	}
})

/** What the consumer's inline run printed last: each property's verdict. */
const Summary = Schema.fromJsonString(Schema.Struct({ verdicts: Schema.Array(Schema.String) }))

const decodeSummary = Schema.decodeUnknownEffect(Summary)

/** A command run to its end in `cwd` with `env` added: its exit code, standard output and standard error. */
export const ran = Effect.fn("ran")(function* (
	cwd: string,
	command: string,
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	return yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(
				ChildProcess.make(command, args, { cwd, stdin: "ignore", extendEnv: true, env })
			),
			(handle) =>
				Effect.all(
					[
						handle.exitCode,
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr))
					],
					{ concurrency: "unbounded" }
				)
		)
	)
})

/** The load hook toolchain-test.sh imports first, so Node strips the types of the library's files under node_modules. */
const STRIP = `data:text/javascript,import { readFileSync } from "node:fs"; import { registerHooks, stripTypeScriptTypes } from "node:module"; registerHooks({ load: (url, context, nextLoad) => url.includes("/node_modules/") && url.endsWith(".ts") ? { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true } : nextLoad(url, context) });`

/** What a consumer's inline run did: its exit code, its summary, the lines it said, and the verdicts it recorded. */
type Ran = Readonly<{
	exitCode: number
	summary: Option.Option<typeof Summary.Type>
	said: ReadonlyArray<string>
	recorded: number
	stderr: string
}>

/**
 * Runs the consumer in `directory` inline in a child process, its verdict cache under `cache`, with git looking no
 * further up than the scratch directory.
 */
export const consumerRun = Effect.fn("consumerRun")(function* (directory: string, cache: string) {
	const fs = yield* FileSystem.FileSystem
	const [exitCode, stdout, stderr] = yield* ran(
		directory,
		process.execPath,
		["--disable-warning=ExperimentalWarning", "--import", STRIP, "./run-inline.mjs"],
		{
			XDG_CACHE_HOME: cache,
			GIT_CEILING_DIRECTORIES: Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/")
		}
	)
	const lines = Arr.filter(Str.split("\n")(stdout), Str.isNonEmpty)
	const summary = yield* Effect.option(
		Effect.flatMap(Effect.fromOption(Arr.last(lines)), decodeSummary)
	)
	const exists = yield* fs.exists(cache)
	const records = exists ? yield* recordsUnder(cache) : 0
	return {
		exitCode,
		summary,
		said: Arr.filter(lines, (line) => !Str.startsWith("{")(line)),
		recorded: records,
		stderr
	} satisfies Ran
})

/** How many verdict records lie under a directory. */
const recordsUnder = (
	directory: string
): Effect.Effect<number, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		let count = 0
		for (const name of yield* fs.readDirectory(directory)) {
			const info = yield* fs.stat(`${directory}/${name}`)
			count +=
				info.type === "Directory"
					? yield* recordsUnder(`${directory}/${name}`)
					: Str.endsWith(".json")(name)
						? 1
						: 0
		}
		return count
	})
