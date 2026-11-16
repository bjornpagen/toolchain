import { Brand, Effect, FileSystem } from "effect"

/**
 * A file's canonical path: what realpath answers, every symlink followed, so one file has one spelling, the one Node
 * names the module by when it loads it. Only realPathOf mints one.
 */
export type RealPath = string & Brand.Brand<"RealPath">

const realPath = Brand.nominal<RealPath>()

/** The canonical path of the file at `path`. */
export const realPathOf = Effect.fnUntraced(function* (path: string) {
	const fs = yield* FileSystem.FileSystem
	const resolved = yield* fs.realPath(path)
	return realPath(resolved)
})

/**
 * One mutant as a worker loads it: the file it replaces, by its canonical path, and the text that file holds instead.
 * A worker started for it loads this text for every import of the file (hook.ts); a worker tree holds it on disk
 * (tree.ts).
 */
export type MutatedFile = Readonly<{ target: RealPath; text: string }>

/**
 * A file's probe: its text with a statement after it that throws as the module finishes loading, so any case whose
 * worker loads the mutated text fails, whatever the file does. A probe that a property survives means the property's
 * workers never loaded the text the mutator gives them, so every mutant of the file would survive unseen.
 */
export const probeOf = (target: RealPath, text: string): MutatedFile => ({
	target,
	text: `${text}\n;throw new Error("the mutator's probe: this module was loaded with the mutated text the mutator gave it")\n`
})
