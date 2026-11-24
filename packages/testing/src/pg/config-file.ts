import { Effect, Path, Schema } from "effect"
import { LocalCluster } from "#pg/spec.ts"

/** The file a package's cluster is stated in, at its root. */
const configFile = "pg.config.ts"

/** pg.config.ts could not be loaded as a cluster's spec, and why. */
class SpecUnloaded extends Schema.TaggedError<SpecUnloaded, { readonly brand: unique symbol }>()(
	"SpecUnloaded",
	{ message: Schema.String }
) {}

/** Whether a module's default export is a cluster's spec, made by localCluster: an instance of its class. */
const isLocalCluster = Schema.is(Schema.instanceOf(LocalCluster))

/**
 * The cluster the package at `directory` states: its pg.config.ts's default export, a LocalCluster, loaded here alone,
 * since its path is known only at run time: what toolchain-pg reads at the directory it runs from (cli.ts), and what the
 * hold properties' run program reads at a case's checkout (hold.fixtures.ts).
 */
export const specAt = (directory: string): Effect.Effect<LocalCluster, SpecUnloaded, Path.Path> =>
	Effect.gen(function* () {
		const paths = yield* Path.Path
		const url = yield* Effect.mapError(
			paths.toFileUrl(paths.resolve(directory, configFile)),
			(bad) => SpecUnloaded.make({ message: `${configFile} has no file URL: ${bad.message}` })
		)
		const namespace = yield* Effect.tryPromise({
			try: (): Promise<unknown> => import(url.href),
			catch: (cause) =>
				SpecUnloaded.make({ message: `${configFile} did not load: ${String(cause)}` })
		})
		const spec: unknown =
			typeof namespace === "object" && namespace !== null
				? Reflect.get(namespace, "default")
				: undefined
		return isLocalCluster(spec)
			? spec
			: yield* SpecUnloaded.make({
					message: `${configFile} must export localCluster({ ... }) (@bjornpagen/testing/pg) as its default`
				})
	})
