import { Effect, FileSystem, Path, Schema } from "effect"
import { Packs, type Toolchain } from "#config.ts"
import { DevtoolFailure, failureFrom } from "#shared/devtool.ts"
import { Repository } from "#shared/repository.ts"
import { EffectFree, Exceptions } from "#workspace/rules.ts"

/** The file every repository holds its toolchain in, at its root. */
export const CONFIG_FILE = "toolchain.config.ts"

/** The file every repository holds its oxlint configuration in, at its root. */
export const LINT_CONFIG_FILE = "oxlint.config.ts"

/** Reasons by name: a rejected rule or diagnostic, and why it is off. */
const Reasons = Schema.Record(Schema.String, Schema.NonEmptyString)

/** A repository's toolchain, as its toolchain.config.ts's default export is decoded: the data through each pack's
 * schema. */
const ToolchainSchema = Schema.Struct({
	rejected: Schema.Struct({ rules: Reasons, diagnostics: Reasons }),
	exceptions: Exceptions,
	effectFree: EffectFree,
	packs: Packs
})

/** The module a toolchain.config.ts is, as far as the loader reads it: its default export. */
const ConfigModule = Schema.Struct({ default: ToolchainSchema })

/** An oxlint override block, as far as the workspace gate reads it: the globs it names and the rules it sets. */
const Override = Schema.Struct({
	files: Schema.Array(Schema.String),
	excludeFiles: Schema.optionalKey(Schema.Array(Schema.String)),
	rules: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})

export type Override = typeof Override.Type

/** An oxlint configuration, as far as the workspace gate reads it: its override blocks. */
const LintConfigModule = Schema.Struct({
	default: Schema.Struct({ overrides: Schema.optionalKey(Schema.Array(Override)) })
})

/**
 * A root module of the repository a tool reads: its file, what it holds and what its export must be, as its refusals
 * name them, and the decoder of its default export.
 */
type RootModule<A> = Readonly<{
	file: string
	holds: string
	exports: string
	decode: (loaded: unknown) => Effect.Effect<Readonly<{ default: A }>, Schema.SchemaError>
}>

/**
 * The default export of the repository's root module `file`, loaded and decoded. A file that is missing, that fails to
 * load or whose export does not decode fails the run: a tool never runs on a configuration it could not read. This is
 * the dev tools' one dynamic import, since the module is the repository's and its path is known only at run time.
 */
const rootModule = <A>(
	module: RootModule<A>
): Effect.Effect<A, DevtoolFailure, FileSystem.FileSystem | Path.Path | Repository> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const { root } = yield* Repository
		const file = path.join(root, module.file)
		if (!(yield* fs.exists(file).pipe(Effect.mapError(failureFrom(`${file} could not be read`))))) {
			return yield* DevtoolFailure.make({
				detail: `${file} is missing: every repository holds its ${module.holds} there`
			})
		}
		const url = yield* path
			.toFileUrl(file)
			.pipe(Effect.mapError(failureFrom(`${file} has no file URL`)))
		const loaded = yield* Effect.tryPromise({
			try: (): Promise<unknown> => import(url.href),
			catch: failureFrom(`${file} failed to load`)
		})
		const { default: config } = yield* module
			.decode(loaded)
			.pipe(Effect.mapError(failureFrom(`${file} does not export ${module.exports}`)))
		return config
	})

/** The repository's toolchain: its root toolchain.config.ts's default export, loaded once per run and decoded. */
export const repositoryToolchain: Effect.Effect<
	Toolchain,
	DevtoolFailure,
	FileSystem.FileSystem | Path.Path | Repository
> = rootModule({
	file: CONFIG_FILE,
	holds: "toolchain",
	exports: "a toolchain this version of the dev tools reads",
	decode: Schema.decodeUnknownEffect(ConfigModule)
})

/** The override blocks of the repository's oxlint configuration: its root oxlint.config.ts's, loaded and decoded. */
export const repositoryOverrides: Effect.Effect<
	ReadonlyArray<Override>,
	DevtoolFailure,
	FileSystem.FileSystem | Path.Path | Repository
> = Effect.map(
	rootModule({
		file: LINT_CONFIG_FILE,
		holds: "oxlint configuration",
		exports: "an oxlint configuration",
		decode: Schema.decodeUnknownEffect(LintConfigModule)
	}),
	(config) => config.overrides ?? []
)
