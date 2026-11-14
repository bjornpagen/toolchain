import { Array as Arr, Effect, FileSystem, Path, Schema } from "effect"
import type { Toolchain } from "#config.ts"
import { DevtoolFailure, failureFrom } from "#shared/devtool.ts"
import { Repository } from "#shared/repository.ts"
import { WebOptions } from "#style/options.ts"
import { EffectFree, Exceptions } from "#workspace/rules.ts"

/** The file every repository holds its toolchain in, at its root. */
const CONFIG_FILE = "toolchain.config.ts"

/** Reasons by name: a rejected rule or diagnostic, and why it is off. */
const Reasons = Schema.Record(Schema.String, Schema.NonEmptyString)

/** A repository's toolchain, as its toolchain.config.ts's default export is decoded: the data through each pack's
 * schema. */
const ToolchainSchema = Schema.Struct({
	rejected: Schema.Struct({ rules: Reasons, diagnostics: Reasons }),
	exceptions: Exceptions,
	effectFree: EffectFree,
	packs: Schema.Array(
		Schema.Union([
			Schema.Struct({ pack: Schema.Literal("drizzle") }),
			Schema.Struct({ pack: Schema.Literal("grizzle") }),
			Schema.Struct({ pack: Schema.Literal("web"), options: WebOptions })
		])
	)
})

/** The module a toolchain.config.ts is, as far as the loader reads it: its default export. */
const ConfigModule = Schema.Struct({ default: ToolchainSchema })

const decodeConfigModule = Schema.decodeUnknownEffect(ConfigModule)

/**
 * The repository's toolchain: its root toolchain.config.ts, loaded once per run and decoded. A file that is missing,
 * that fails to load, whose export does not decode, or that names a pack twice fails the run: a tool never runs on a
 * toolchain it could not read. This is the dev tools' one dynamic import, since the module is the repository's and
 * its path is known only at run time.
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
	const names = Arr.map(config.packs, (pack) => pack.pack)
	const twice = Arr.filter(
		Arr.dedupe(names),
		(name) => Arr.filter(names, (other) => other === name).length > 1
	)
	if (Arr.isReadonlyArrayNonEmpty(twice)) {
		return yield* DevtoolFailure.make({
			detail: `${file} names a pack more than once: ${Arr.join(twice, ", ")}`
		})
	}
	return config
})
