import { Array as Arr, Effect, Option, Path, Schema, String as Str } from "effect"
import * as ts from "typescript/ast"
import { createFileSystemLayer, type FileSystemCallbacks, serverFS } from "typescript/fs"
import {
	API,
	type Diagnostic,
	DiagnosticCategory,
	type Program,
	type Snapshot
} from "typescript/sync"
import type { MutatedFile, RealPath } from "#mutate/mutated.ts"

/**
 * The native compiler refused to type a package: it did not start or open the package's project, or the unmutated
 * package does not typecheck, so no mutant of it can be told valid.
 */
export class TypecheckRefused extends Schema.TaggedError<
	TypecheckRefused,
	{ readonly brand: unique symbol }
>()("TypecheckRefused", { message: Schema.String }) {}

const refused = (message: string) => (cause: unknown) =>
	TypecheckRefused.make({ message: `${message}: ${String(cause)}` })

/** Diagnostics a mutant raises only by leaving code unused or unreachable: no type error. */
const UNUSED: ReadonlySet<number> = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 7027])

/** The compiler reads the package from disk and writes nothing. */
const readOnlyHost: FileSystemCallbacks = {
	directoryExists: serverFS.useOS,
	fileExists: serverFS.useOS,
	getAccessibleEntries: serverFS.useOS,
	readFile: serverFS.useOS,
	realpath: serverFS.useOS,
	stat: serverFS.useOS,
	writeFile: serverFS.noop,
	removeFile: serverFS.noop
}

const diagnosticText = (diagnostic: Diagnostic) =>
	`${diagnostic.fileName ?? "(program)"}:${String((diagnostic.startPosition?.line ?? 0) + 1)}: TS${String(diagnostic.code)} ${diagnostic.text}`

/** A snapshot's program of the package; a snapshot that holds no such program refuses. */
const programOf = (snapshot: Snapshot, config: string) =>
	Effect.flatMap(
		Effect.try({
			try: () => snapshot.getConfiguredProject(config),
			catch: refused("the native compiler failed")
		}),
		(project) =>
			project === undefined
				? Effect.fail(
						TypecheckRefused.make({
							message: `the native compiler opened no project for ${config}`
						})
					)
				: Effect.succeed(project.program)
	)

/** The errors among diagnostics. */
const errorsIn = (diagnostics: ReadonlyArray<Diagnostic>) =>
	Arr.filter(diagnostics, (diagnostic) => diagnostic.category === DiagnosticCategory.Error)

/** Every error of a program: its configuration's, its own and every file's. */
const everyError = (program: Program) =>
	Effect.try({
		try: () =>
			errorsIn([
				...program.getConfigFileParsingDiagnostics(),
				...program.getProgramDiagnostics(),
				...program.getGlobalDiagnostics(),
				...program.getSyntacticDiagnostics(),
				...program.getSemanticDiagnostics()
			]),
		catch: refused("the native compiler failed")
	})

/** Whether a file is the repository's own, not an installed package's: only the repository's files are mutated. */
const isOwn = (file: string) => !Str.includes("/node_modules/")(file)

/**
 * The files of a program whose types read each of its own files: for every file, those that import it, directly or
 * through others, by any import, export or import type a file holds, `import type` included, as the compiler resolves
 * it. A mutant edits an expression of one file, never an import or a type, so only these files' types can change
 * with it, and a type error it makes stands in one of them or in the file itself.
 */
const readersOf = (program: Program) =>
	Effect.try({
		try: () => {
			const own: ReadonlyArray<ts.RootedFilePath> = Arr.filter(program.getSourceFileNames(), isOwn)
			const edges = Arr.flatMap(own, (file: ts.RootedFilePath) =>
				Option.match(Option.fromUndefinedOr(program.getSourceFile(file)), {
					onNone: () => [],
					onSome: (source) =>
						Arr.flatMap(source.imports, (specifier) =>
							ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)
								? Option.match(
										Option.fromUndefinedOr(
											program.getResolvedModuleFromModuleSpecifier(specifier, file)
										),
										{
											onNone: () => [],
											onSome: (resolved) =>
												isOwn(resolved.resolvedFileName)
													? [[resolved.resolvedFileName, String(file)] as const]
													: []
										}
									)
								: []
						)
				})
			)
			const importers = new Map<string, Array<string>>()
			for (const [imported, importer] of edges) {
				const known = importers.get(imported)
				if (known === undefined) {
					importers.set(imported, [importer])
				} else {
					known.push(importer)
				}
			}
			return (file: string): ReadonlyArray<string> => {
				const reached = new Set([file])
				const pending = [file]
				for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
					for (const importer of importers.get(next) ?? []) {
						if (!reached.has(importer)) {
							reached.add(importer)
							pending.push(importer)
						}
					}
				}
				return Arr.fromIterable(reached)
			}
		},
		catch: refused("the native compiler did not resolve the program's imports")
	})

/**
 * The package at `pkg` typed once in one native compiler session for the enclosing scope, and whether a mutant's
 * program has a type error the unmutated program does not: the unmutated snapshot with the mutant's text overlaid on
 * its file, in a snapshot of its own, checked in the files whose types can change with it, the file and its readers
 * (readersOf), not every file of the program. The unmutated program must have no error at all. A mutant with a type
 * error is invalid: no one could commit it, so no property need kill it.
 */
export const typecheckerOf = Effect.fn("testing.mutate.typecheckerOf")(function* (pkg: RealPath) {
	const path = yield* Path.Path
	const config = path.join(pkg, "tsconfig.json")
	const api = yield* Effect.acquireRelease(
		Effect.try({
			try: () => new API({ cwd: pkg, fs: readOnlyHost }),
			catch: refused("the native compiler did not start")
		}),
		(session) =>
			Effect.sync(() => {
				session.close()
			})
	)
	const unmutated = yield* Effect.acquireDisposable(
		Effect.try({
			try: () => api.createSnapshot({ openProjects: [config] }),
			catch: refused("the native compiler did not open the package")
		})
	)
	const program = yield* programOf(unmutated, config)
	const baseline = yield* everyError(program)
	if (Arr.isReadonlyArrayNonEmpty(baseline)) {
		return yield* TypecheckRefused.make({
			message: `the unmutated package does not typecheck:\n${Arr.join(Arr.map(baseline, diagnosticText), "\n")}`
		})
	}
	const readers = yield* readersOf(program)
	return (mutated: MutatedFile): Effect.Effect<boolean, TypecheckRefused> =>
		Effect.scoped(
			Effect.flatMap(
				Effect.acquireDisposable(
					Effect.try({
						try: () =>
							unmutated.update({
								fileSystem: createFileSystemLayer([[mutated.target, mutated.text]]),
								ensurePrograms: true
							}),
						catch: refused("the native compiler did not overlay the mutant")
					})
				),
				(snapshot) =>
					Effect.flatMap(programOf(snapshot, config), (mutant) =>
						Effect.try({
							try: () =>
								Arr.some(
									errorsIn([
										...mutant.getSyntacticDiagnostics(mutated.target),
										...mutant.getSemanticDiagnostics(readers(mutated.target))
									]),
									(error) => !UNUSED.has(error.code)
								),
							catch: refused("the native compiler failed")
						})
					)
			)
		)
})
