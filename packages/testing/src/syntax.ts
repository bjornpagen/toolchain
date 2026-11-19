import { Array as Arr, Effect, Option, Schema } from "effect"
import type * as ts from "typescript/ast"
import { API } from "typescript/sync"

/**
 * TypeScript's syntax as the library reads it, through one door: TypeScript 7's native parser, one compiler process
 * for this process's life, started at its first parse and shared by every reader of syntax the process runs (what a
 * module loads, runner/closure.ts; the code the mutator mutates, mutants.ts; a repository's own properties that read
 * printed source back, its tree and its syntax errors), so a run starts it once however many pools, kill trials and
 * mutated files it reads, and no reader starts a compiler process of its own. The compiler process is unreferenced, so it holds no process open, and
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

/**
 * A syntax error TypeScript reports of a text: its code (TS1005 is 1005), its message, and the half-open range of the
 * text it spans, in UTF-16 code units.
 */
export type SyntaxDiagnostic = Readonly<{ code: number; message: string; pos: number; end: number }>

/**
 * The syntax errors TypeScript reports of `text` parsed as the file named `file` (whose extension is its kind), in the
 * order it reports them, none for a text that parses: transpileModule's, which builds no program and reads no type, so
 * a type error is none of them.
 */
export const syntaxDiagnosticsOf = (
	file: string,
	text: string
): Effect.Effect<ReadonlyArray<SyntaxDiagnostic>, SyntaxUnread> =>
	Effect.flatMap(parser, (api) =>
		Effect.try({
			try: () =>
				Arr.map(
					api.transpileModule(text, { fileName: file, reportDiagnostics: true }).diagnostics ?? [],
					(diagnostic): SyntaxDiagnostic => ({
						code: diagnostic.code,
						message: diagnostic.text,
						pos: diagnostic.pos,
						end: diagnostic.end
					})
				),
			catch: (cause) => SyntaxUnread.make({ file: Option.some(file), cause })
		})
	)
