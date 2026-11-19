import { Effect, Option, Schema } from "effect"
import type * as ts from "typescript/ast"
import { API } from "typescript/sync"

/**
 * TypeScript's syntax as the library reads it, through one door: TypeScript 7's native parser, one compiler process
 * for this process's life, started at its first parse and shared by every reader of syntax the process runs (what a
 * module loads, runner/closure.ts; the code the mutator mutates, mutants.ts), so a run starts it once however many
 * pools, kill trials and mutated files it reads. The compiler process is unreferenced, so it holds no process open, and
 * it ends with its pipes. Each text is parsed as the file it is named, its kind its extension's: a .tsx file's markup is
 * TSX, and a .ts file's angle brackets are type assertions and comparisons.
 */

/** The native parser did not start, or did not read a file. */
export class SyntaxUnread extends Schema.TaggedError<
	SyntaxUnread,
	{ readonly brand: unique symbol }
>()("SyntaxUnread", { file: Schema.Option(Schema.String), cause: Schema.Defect() }) {}

declare global {
	var bjornpagenTestingParser: API | undefined
}

/** This process's native parser, started at its first parse. */
const parser: Effect.Effect<API, SyntaxUnread> = Effect.try({
	try: () => {
		globalThis.bjornpagenTestingParser ??= new API()
		return globalThis.bjornpagenTestingParser
	},
	catch: (cause) => SyntaxUnread.make({ file: Option.none(), cause })
})

/**
 * What `read` makes of `text`'s syntax tree, parsed as the file named `file` (an absolute path, whose extension is its
 * kind), which the parser lets go of once `read` returns, so `read` keeps no node of it.
 */
export const syntaxOf = <A>(
	file: string,
	text: string,
	read: (tree: ts.SourceFile) => A
): Effect.Effect<A, SyntaxUnread> =>
	Effect.flatMap(parser, (api) =>
		Effect.acquireUseRelease(
			Effect.try({
				try: () => api.createSourceFile(file, text),
				catch: (cause) => SyntaxUnread.make({ file: Option.some(file), cause })
			}),
			(retained) => Effect.sync(() => read(retained.sourceFile)),
			(retained) =>
				Effect.ignore(
					Effect.try({
						try: () => retained[Symbol.dispose](),
						catch: (cause) => SyntaxUnread.make({ file: Option.some(file), cause })
					})
				)
		)
	)
