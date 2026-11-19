import { Effect, FileSystem, Option, Path, Ref, type Scope } from "effect"
import type { Loading } from "#mutate/checkout.ts"
import type { MutatedFile, RealPath } from "#mutate/mutated.ts"
import type { WorkerImage } from "#mutate/pool.ts"
import { mutantIn, type TreeFailed, type Trees } from "#mutate/tree.ts"
import { processScratch } from "#resources/scratch.ts"

/** A string as a JavaScript string literal that decodes to it: its URI encoding holds no quote and no backslash. */
const literal = (text: string) => `decodeURIComponent("${encodeURIComponent(text)}")`

/** The name of the file that marks a process a coverage pass forked: `started-<pid>`. */
export const STARTED = "started-"

/**
 * The `--import` that marks each worker a coverage pass forks: a data: URL whose module writes an empty file named
 * `started-<pid>` into the pass's dump directory (NODE_V8_COVERAGE) as the process starts, when it is a child of
 * `parent`, the process that forks the pass's workers. A worker's dump is written only as it exits, so a worker ended
 * before it exits on its own (as the pool ends one past its grace) leaves its mark and no dump, and the pass reads that
 * as coverage lost, never as less coverage. A process a check starts has another parent and is not marked.
 */
export const startedMark = (parent: number): ReadonlyArray<string> => [
	"--import",
	`data:text/javascript,${encodeURIComponent(
		`import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const dumps = process.env.NODE_V8_COVERAGE; if (process.ppid === ${String(parent)} && dumps !== undefined) { mkdirSync(dumps, { recursive: true }); writeFileSync(join(dumps, ${literal(STARTED)} + String(process.pid)), "") }`
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
 * served by the module hook (pool.ts Served), its text in a file of the run's directory for the enclosing scope; in a
 * tree, it is written into a tree lent for the enclosing scope (Trees.take), and the tree's own text is back when the
 * scope closes. A coverage pass's image is the checkout as it is, with NODE_V8_COVERAGE naming the directory its dumps
 * go to, which every child process a check starts inherits, and each worker marked as it starts
 * (startedMark).
 */
export const imagesOf = Effect.fn("testing.mutate.imagesOf")(function* (
	checkout: RealPath,
	trees: Trees
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
	const texts = yield* processScratch("toolchain-mutants-")
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
	const plain: WorkerImage = { root: checkout, served: Option.none(), env: {} }
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
							served: Option.some({ mutant: loaded, textFile: file })
						}))
				})
			case "tree":
				return Effect.gen(function* () {
					const tree = yield* trees.take
					if (Option.isSome(mutant)) {
						yield* Effect.provideContext(mutantIn(tree, mutant.value), services)
					}
					const image: WorkerImage = { root: tree.root, served: Option.none(), env: {} }
					return image
				})
		}
	}
	const images: Images = {
		open,
		covered: (dumps) => ({
			...plain,
			execArgv: startedMark(process.pid),
			env: { NODE_V8_COVERAGE: dumps }
		})
	}
	return images
})
