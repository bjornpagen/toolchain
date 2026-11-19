import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import {
	Array as Arr,
	Console,
	DateTime,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Record as Rec,
	Result,
	Schema,
	String as Str
} from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { convert, type Outcome, type Place } from "#codemod/convert.ts"
import { PLUGINS, type PluginName } from "#codemod/plugins/index.ts"
import { type Reported, tsvOf } from "#codemod/report.ts"
import { openParser, type Parser } from "#codemod/syntax.ts"

/**
 * `node packages/testing/scripts/codemod/main.ts --plugin <repository> --repo <checkout> --report <file.tsv> [file ...]`:
 * converts a repository's search-based Vitest test modules into property modules, in place, in the checkout named (a
 * clone of its own: the codemod writes the modules it converts). With no files it reads every module the plugin's
 * pathspecs list (`git ls-files`). Each module is converted whole or left untouched; a converted module holds its
 * properties only, and what they read moves to its fixtures module beside it (`<name>.fixtures.ts`, imported through
 * the package's own import map); both are printed by oxfmt under the repository's configuration. The report, a TSV,
 * lists every module with its outcome, why each untouched one was left (report.ts REASONS) and what each conversion did
 * that a person must know (NOTES). Temporary: it goes with Vitest, once every repository is converted.
 */

/** A module the native compiler could not read. */
class ModuleUnread extends Schema.TaggedError<ModuleUnread, { readonly brand: unique symbol }>()(
	"ModuleUnread",
	{ file: Schema.String }
) {}

/** The part of a package.json the codemod reads: its import map, each entry a target or conditions. */
const Manifest = Schema.Struct({
	imports: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
})

/** A test module's name, which its fixtures module's replaces. */
const TEST_SUFFIX = regex("\\.test\\.ts$")

/**
 * The specifier a package's import map names `file` by (a path from the package's root): the wildcard entry whose
 * target directory holds it most closely, `#test/*` → `./test/*` naming `test/a/b.ts` as `#test/a/b.ts`.
 */
const specifierIn = (
	imports: Readonly<Record<string, unknown>>,
	file: string
): Option.Option<string> =>
	Option.map(
		Arr.last(
			Arr.sort(
				Arr.filterMap(Rec.toEntries(imports), ([key, target]) => {
					if (
						typeof target !== "string" ||
						!Str.endsWith("*")(key) ||
						!Str.startsWith("./")(target) ||
						!Str.endsWith("*")(target)
					) {
						return Result.failVoid
					}
					const directory = Str.slice(2, -1)(target)
					return Str.startsWith(directory)(file)
						? Result.succeed([
								directory,
								`${Str.slice(0, -1)(key)}${Str.slice(directory.length)(file)}`
							] as const)
						: Result.failVoid
				}),
				Order.mapInput(Order.Number, ([directory]: readonly [string, string]) => directory.length)
			)
		),
		([, specifier]) => specifier
	)

const convertOne = (
	parser: Parser,
	plugin: PluginName,
	file: string,
	text: string,
	place: Place,
	since: string,
	base: string
) =>
	Effect.try({
		try: (): Outcome =>
			convert(parser, PLUGINS[plugin], parser.parse(file, text), place, since, base),
		catch: () => ModuleUnread.make({ file })
	})

const run = Effect.fn("codemod.run")(function* (input: {
	readonly plugin: PluginName
	readonly repo: string
	readonly report: string
	readonly files: ReadonlyArray<string>
}) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const repo = path.resolve(input.repo)
	const oxfmt = path.resolve(import.meta.dirname, "../../../../node_modules/.bin/oxfmt")
	const listed = yield* spawner.lines(
		ChildProcess.make("git", ["ls-files", "--", ...PLUGINS[input.plugin].include], { cwd: repo })
	)
	const every = yield* spawner.lines(ChildProcess.make("git", ["ls-files"], { cwd: repo }))
	const tracked = new Set(every)
	const files = Arr.isReadonlyArrayNonEmpty(input.files)
		? input.files
		: Arr.filter(listed, Str.isNonEmpty)
	const manifestOf = (directory: string) =>
		Effect.flatMap(fs.readFileString(path.join(repo, directory, "package.json")), (text) =>
			Schema.decodeEffect(Schema.fromJsonString(Manifest))(text)
		)
	const placeOf = Effect.fn("codemod.place")(function* (file: string) {
		const fixtures = Str.replace(TEST_SUFFIX, ".fixtures.ts")(file)
		if (tracked.has(fixtures)) {
			return Result.fail(`${fixtures} is already a module`)
		}
		const directories = Arr.scan(Arr.dropRight(Str.split(fixtures, "/"), 1), "", (at, part) =>
			at === "" ? part : `${at}/${part}`
		)
		const manifests = yield* Effect.filter(Arr.reverse(directories), (directory) =>
			fs.exists(path.join(repo, directory, "package.json"))
		)
		const nearest = Arr.head(manifests)
		if (Option.isNone(nearest)) {
			return Result.fail(`no package.json above ${fixtures}`)
		}
		const directory = nearest.value
		const manifest = yield* manifestOf(directory)
		const inPackage = directory === "" ? fixtures : Str.slice(directory.length + 1)(fixtures)
		return Option.match(specifierIn(manifest.imports ?? {}, inPackage), {
			onNone: (): Place =>
				Result.fail(
					`no import map entry of ${directory === "" ? "." : directory} names ${fixtures}`
				),
			onSome: (specifier): Place => Result.succeed({ file: fixtures, specifier, root: directory })
		})
	})
	const now = yield* DateTime.now
	const since = DateTime.formatIsoDateUtc(now)
	const head = yield* spawner.lines(
		ChildProcess.make("git", ["rev-parse", "--short=9", "HEAD"], { cwd: repo })
	)
	const base = Arr.join(head, "")
	const parser = yield* Effect.acquireRelease(
		Effect.sync(() => openParser(repo)),
		(opened) => Effect.sync(() => opened.close())
	)
	const outcomes = yield* Effect.forEach(files, (file) =>
		Effect.gen(function* () {
			const text = yield* fs.readFileString(path.join(repo, file))
			const place = yield* placeOf(file)
			return yield* convertOne(parser, input.plugin, file, text, place, since, base)
		})
	)
	const written = yield* Effect.forEach(outcomes, (o) =>
		Option.match(o.output, {
			onNone: () => Effect.succeed(Arr.empty<ReadonlyArray<string>>()),
			onSome: (output) =>
				Effect.as(
					Effect.forEach(
						[
							{ file: o.file, text: output.test },
							...Option.toArray(output.fixtures),
							...output.kept
						],
						(module) => fs.writeFileString(path.join(repo, module.file), module.text),
						{ discard: true }
					),
					[
						[
							o.file,
							...Option.toArray(Option.map(output.fixtures, (f) => f.file)),
							...Arr.map(output.kept, (k) => k.file)
						]
					]
				)
		})
	)
	const modules = Arr.flatten(written)
	const formats = (batch: ReadonlyArray<string>) =>
		Effect.map(
			spawner.exitCode(
				ChildProcess.make(oxfmt, [...batch], { cwd: repo, stdout: "ignore", stderr: "ignore" })
			),
			(code) => code === 0
		)
	const everyFormats = Arr.isReadonlyArrayNonEmpty(modules)
		? yield* formats(Arr.flatten(modules))
		: true
	const unformatted = everyFormats
		? []
		: yield* Effect.filter(modules, (group) => Effect.map(formats(group), (ok) => !ok))
	yield* Effect.forEach(
		unformatted,
		(group) =>
			Effect.andThen(
				spawner.exitCode(
					ChildProcess.make("git", ["checkout", "--", ...Arr.take(group, 1)], { cwd: repo })
				),
				Effect.forEach(Arr.drop(group, 1), (f) => fs.remove(path.join(repo, f)), {
					discard: true
				})
			),
		{ discard: true }
	)
	const refused = new Set(Arr.flatMap(unformatted, (group) => Arr.take(group, 1)))
	const reported: ReadonlyArray<Reported> = Arr.map(outcomes, (o) =>
		refused.has(o.file)
			? {
					file: o.file,
					status: "hand",
					findings: [
						{ code: "codemod-output", line: 1, detail: "the converted module did not parse" }
					]
				}
			: { file: o.file, status: o.status, findings: o.findings }
	)
	yield* fs.writeFileString(path.resolve(input.report), tsvOf(reported))
	const count = (status: Reported["status"]) =>
		Arr.filter(reported, (r) => r.status === status).length
	yield* Console.log(
		`${input.plugin}: ${files.length} modules, ${count("converted")} converted, ${count("hand")} left with reasons, ${count("not-a-search")} not searches; report ${path.resolve(input.report)}`
	)
}, Effect.scoped)

const codemod = Command.make(
	"codemod",
	{
		plugin: Flag.Literals("plugin", Rec.keys(PLUGINS)),
		repo: Flag.String("repo"),
		report: Flag.String("report"),
		files: Argument.String("file").pipe(Argument.variadic())
	},
	run
)

NodeRuntime.runMain(
	Command.run(codemod, { version: "source" }).pipe(Effect.provide(NodeServices.layer))
)
