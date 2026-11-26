import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Cause, Effect, Option, Schema } from "effect"
import { reportOf, type ModuleVerdict } from "#runner/load-report.ts"
import { discover } from "#runner/load.ts"
import { answeredChunk } from "#runner/resolutions.ts"

/**
 * One test module loaded apart (`toolchain-test load`, loads.ts), in a process of its own, which its entry
 * (load-entry.ts) runs once it holds the resolutions its parent handed it: the module imported through the runner's own
 * discover, as a worker loads a property's module, so a module that throws as it loads, or exports anything but
 * properties, fails here as it fails a run. Whatever its module came to, the process writes its compile cache, reports
 * on its descriptor 3 (load-report.ts: its verdict and what Node resolved for it that it was not handed, every specifier
 * of its module's closure resolved before any module of it ran, so a module that throws hands back its whole closure
 * too), closes the descriptor and returns, its effect never failing, so Effect's runMain calls no process.exit; it ends
 * as its event loop drains, or its parent ends its process group, whatever its module left open.
 *
 *   node runner/load-entry.ts <package root> <module>
 */

/** The entry was not given one package root and one module. */
class LoadUnasked extends Schema.TaggedError<LoadUnasked, { readonly brand: unique symbol }>()(
	"LoadUnasked",
	{ message: Schema.String }
) {}

/** The descriptor a load's process reports on: the parent's pipe beside the standard streams. */
const REPORT = 3

/** Writes this process's compile cache and its report whole, then closes the descriptor the report is on. */
const reported = (verdict: ModuleVerdict): void => {
	process.getBuiltinModule("node:module").flushCompileCache()
	const fs = process.getBuiltinModule("node:fs")
	for (const part of reportOf(verdict, answeredChunk())) {
		for (let written = 0; written < part.length;) {
			written += fs.writeSync(REPORT, part, written, part.length - written)
		}
	}
	fs.closeSync(REPORT)
}

const main = Effect.gen(function* () {
	const [root, module, ...extra] = Arr.drop(process.argv, 2)
	if (root === undefined || module === undefined || Arr.isReadonlyArrayNonEmpty(extra)) {
		return yield* LoadUnasked.make({ message: "load-entry.ts takes a package root and one module" })
	}
	yield* discover(root, [module])
})

NodeRuntime.runMain(
	main.pipe(
		Effect.matchCause({
			onSuccess: (): ModuleVerdict => ({ kind: "loads" }),
			onFailure: (cause): ModuleVerdict => ({
				kind: "failed",
				message: Option.match(Cause.findErrorOption(cause), {
					onNone: () => Cause.pretty(cause),
					onSome: (error) => error.message
				})
			})
		}),
		Effect.flatMap((verdict) => Effect.sync(() => reported(verdict))),
		Effect.provide(NodeServices.layer)
	)
)
