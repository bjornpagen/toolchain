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

const decodeConfigModule = Schema.decodeUnknownEffect(ConfigModule)

/**
 * The repository's toolchain: its root toolchain.config.ts, loaded once per run and decoded. A file that is missing,
 * that fails to load or whose export does not decode fails the run: a tool never runs on a toolchain it could not
 * read. This is the dev tools' one dynamic import, since the module is the repository's and its path is known only at
 * run time.
 */
export const repositoryToolchain: Effect.Effect<
	Toolchain,
	DevtoolFailure,
	FileSystem.FileSystem | Path.Path | Repository
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { root } = yield* Repository
	const file = path.join(root, CONFIG_FILE)
	if (!(yield* fs.exists(file).pipe(Effect.mapError(failureFrom(`${file} could not be read`))))) {
		return yield* DevtoolFailure.make({
			detail: `${file} is missing: every repository holds its toolchain there`
		})
	}
	const url = yield* path
		.toFileUrl(file)
		.pipe(Effect.mapError(failureFrom(`${file} has no file URL`)))
	const loaded = yield* Effect.tryPromise({
		try: (): Promise<unknown> => import(url.href),
		catch: failureFrom(`${file} failed to load`)
	})
	const { default: config } = yield* decodeConfigModule(loaded).pipe(
		Effect.mapError(
			failureFrom(`${file} does not export a toolchain this version of the dev tools reads`)
		)
	)
	return config
})

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

const decodeLintConfigModule = Schema.decodeUnknownEffect(LintConfigModule)

/**
 * The override blocks of the repository's oxlint configuration: its root oxlint.config.ts, loaded and decoded. A file
 * that is missing, that fails to load or whose export does not decode fails the run.
 */
export const repositoryOverrides: Effect.Effect<
	ReadonlyArray<Override>,
	DevtoolFailure,
	FileSystem.FileSystem | Path.Path | Repository
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { root } = yield* Repository
	const file = path.join(root, LINT_CONFIG_FILE)
	if (!(yield* fs.exists(file).pipe(Effect.mapError(failureFrom(`${file} could not be read`))))) {
		return yield* DevtoolFailure.make({
			detail: `${file} is missing: every repository holds its oxlint configuration there`
		})
	}
	const url = yield* path
		.toFileUrl(file)
		.pipe(Effect.mapError(failureFrom(`${file} has no file URL`)))
	const loaded = yield* Effect.tryPromise({
		try: (): Promise<unknown> => import(url.href),
		catch: failureFrom(`${file} failed to load`)
	})
	const { default: config } = yield* decodeLintConfigModule(loaded).pipe(
		Effect.mapError(failureFrom(`${file} does not export an oxlint configuration`))
	)
	return config.overrides ?? []
})
