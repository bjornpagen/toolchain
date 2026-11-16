import { Array as Arr, Effect, Path, Schema } from "effect"
import { createFileSystemLayer, type FileSystemCallbacks, serverFS } from "typescript/fs"
import { API, type Diagnostic, DiagnosticCategory, type Snapshot } from "typescript/sync"
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

/** A snapshot's errors in the package's program; a snapshot that holds no such program refuses. */
const errorsOf = (snapshot: Snapshot, config: string) =>
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
				: Effect.try({
						try: () =>
							Arr.filter(
								[
									...project.program.getConfigFileParsingDiagnostics(),
									...project.program.getProgramDiagnostics(),
									...project.program.getGlobalDiagnostics(),
									...project.program.getSyntacticDiagnostics(),
									...project.program.getSemanticDiagnostics()
								],
								(diagnostic) => diagnostic.category === DiagnosticCategory.Error
							),
						catch: refused("the native compiler failed")
					})
	)

/**
 * The package at `pkg` typed once in one native compiler session for the enclosing scope, and whether a mutant's
 * program has a type error the unmutated program does not: the unmutated snapshot with the mutant's text overlaid on
 * its file, in a snapshot of its own. The unmutated program must have no error at all. A mutant with a type error is
 * invalid: no one could commit it, so no property need kill it.
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
	const baseline = yield* errorsOf(unmutated, config)
	if (Arr.isReadonlyArrayNonEmpty(baseline)) {
		return yield* TypecheckRefused.make({
			message: `the unmutated package does not typecheck:\n${Arr.join(Arr.map(baseline, diagnosticText), "\n")}`
		})
	}
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
					Effect.map(errorsOf(snapshot, config), (errors) =>
						Arr.some(errors, (error) => !UNUSED.has(error.code))
					)
			)
		)
})
