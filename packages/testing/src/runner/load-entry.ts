import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Cause, Effect, Option, Schema } from "effect"
import { discover } from "#runner/load.ts"

/**
 * One test module loaded apart (`toolchain-test load`, loads.ts), in a process of its own: the module imported through
 * the runner's own discover, as a worker loads a property's module, so a module that throws as it loads, or exports
 * anything but properties, fails here as it fails a run. It prints what failed and exits 1; a module that loads exits
 * 0, whatever its load left open.
 *
 *   node runner/load-entry.ts <package root> <module>
 */

/** The entry was not given one package root and one module. */
class LoadUnasked extends Schema.TaggedError<LoadUnasked, { readonly brand: unique symbol }>()(
	"LoadUnasked",
	{ message: Schema.String }
) {}

const main = Effect.gen(function* () {
	const [root, module, ...extra] = Arr.drop(process.argv, 2)
	if (root === undefined || module === undefined || Arr.isReadonlyArrayNonEmpty(extra)) {
		return yield* LoadUnasked.make({ message: "load-entry.ts takes a package root and one module" })
	}
	yield* discover(root, [module])
})

NodeRuntime.runMain(
	main.pipe(
		Effect.matchCauseEffect({
			onSuccess: () => Effect.sync(() => process.exit(0)),
			onFailure: (cause) =>
				Effect.sync(() => {
					process.stderr.write(
						`${Option.match(Cause.findErrorOption(cause), {
							onNone: () => Cause.pretty(cause),
							onSome: (error) => error.message
						})}\n`
					)
					process.exit(1)
				})
		}),
		Effect.provide(NodeServices.layer)
	)
)
