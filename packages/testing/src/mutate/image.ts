import { Effect, FileSystem, Option, Path, Ref, type Scope } from "effect"
import type { Loading } from "#mutate/checkout.ts"
import type { MutatedFile, RealPath } from "#mutate/mutated.ts"
import type { WorkerImage } from "#mutate/pool.ts"
import { mutantIn, type TreeFailed, type Trees } from "#mutate/tree.ts"

/** A string as a JavaScript string literal that decodes to it: its URI encoding holds no quote and no backslash. */
const literal = (text: string) => `decodeURIComponent("${encodeURIComponent(text)}")`

/**
 * The `--import` that starts a worker with `mutant` loaded: a data: URL whose module calls the hook (hook.ts) with the
 * mutant's file and the file holding its text, so the worker reads them from its own command line and nothing else.
 */
const hookImport = (mutant: MutatedFile, textFile: string): ReadonlyArray<string> => [
	"--import",
	`data:text/javascript,${encodeURIComponent(
		`const { serve } = await import(${literal(import.meta.resolve("#mutate/hook.ts"))}); serve(${literal(mutant.target)}, ${literal(textFile)})`
	)}`
]

/**
 * What a run's workers start from: images of its checkout, as it is or with one mutant loaded, in process or in a
 * worker tree (open), and a coverage pass's (covered).
 */
export type Images = Readonly<{
	open: (
		loading: Loading,
		mutant: Option.Option<MutatedFile>
	) => Effect.Effect<WorkerImage, TreeFailed, Scope.Scope>
	covered: (dumps: string) => WorkerImage
}>

/**
 * The images of a run over the checkout at `checkout`, whose worker trees are `trees`. A mutant loaded in process is
 * the hook's (hookImport), its text in a file of the run's directory for the enclosing scope; in a tree, it is written
 * into a tree lent for the enclosing scope (Trees.take), and the tree's own text is back when the scope closes. A
 * coverage pass's image is the checkout as it is, with NODE_V8_COVERAGE naming the directory its dumps go to, which every
 * child process a check starts inherits.
 */
export const imagesOf = Effect.fn("testing.mutate.imagesOf")(function* (
	checkout: RealPath,
	trees: Trees
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
	const texts = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-mutants-" })
	const written = yield* Ref.make(0)
	const textFile = (text: string) =>
		Effect.gen(function* () {
			const index = yield* Ref.getAndUpdate(written, (n) => n + 1)
			const file = path.join(texts, `${String(index)}.txt`)
			yield* Effect.acquireRelease(fs.writeFileString(file, text), () =>
				Effect.ignore(fs.remove(file))
			)
			return file
		}).pipe(Effect.orDie)
	const plain: WorkerImage = { root: checkout, execArgv: [], env: {} }
	const open = (
		loading: Loading,
		mutant: Option.Option<MutatedFile>
	): Effect.Effect<WorkerImage, TreeFailed, Scope.Scope> => {
		switch (loading) {
			case "in-process":
				return Option.match(mutant, {
					onNone: () => Effect.succeed(plain),
					onSome: (loaded) =>
						Effect.map(textFile(loaded.text), (file): WorkerImage => ({
							...plain,
							execArgv: hookImport(loaded, file)
						}))
				})
			case "tree":
				return Effect.gen(function* () {
					const tree = yield* trees.take
					if (Option.isSome(mutant)) {
						yield* Effect.provideContext(mutantIn(tree, mutant.value), services)
					}
					const image: WorkerImage = { root: tree.root, execArgv: [], env: {} }
					return image
				})
		}
	}
	const images: Images = {
		open,
		covered: (dumps) => ({ ...plain, env: { NODE_V8_COVERAGE: dumps } })
	}
	return images
})
