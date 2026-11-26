import { layerDigest } from "@effect/platform-node/NodeCrypto"
import { type Array as Arr, Effect, Layer } from "effect"
import { closuresOf, moduleSyntax, type RepoPath, workingTree } from "#runner/closure.ts"

export { type Closure, type ClosureFailure, type RepoPath, repoPathOf } from "#runner/closure.ts"

/**
 * The closure of each of `roots` (at least one, so a bound over them is never vacuous), files of the repository at
 * `checkout` (absolute) named from its root, in its working tree: every
 * file a root loads at run time, transitively, and the packages and built-ins it holds by name, as Node loads them for
 * these repositories under its own conditions and `conditions`, for this Node. It is the runner's one resolver
 * (runner/closure.ts, which keys every verdict and is held to Node's own loader), so a test that bounds what a process
 * loading a root loads (a serving process's entry, a bundle's) reads it here and never resolves a module itself.
 */
export const closuresAt = (
	checkout: string,
	roots: Arr.NonEmptyReadonlyArray<RepoPath>,
	conditions: ReadonlyArray<string>
) =>
	Effect.scoped(
		Effect.flatMap(
			Effect.all([workingTree(checkout), Layer.build(Layer.merge(moduleSyntax, layerDigest))]),
			([tree, services]) =>
				closuresOf({ tree, conditions, runtime: process.version, roots }).pipe(
					Effect.provideContext(services)
				)
		)
	)
