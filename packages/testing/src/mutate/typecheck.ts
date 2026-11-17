import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	Scope,
	String as Str,
	SynchronizedRef
} from "effect"
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
 * The native compiler refused to type a package: it did not start or open the package's project, the project holds no
 * file a mutant replaces, or a file a verdict reads does not typecheck unmutated, so no mutant of it can be told valid.
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

/** The errors a program finds in `file`'s syntax and in the types of `files` (`file` among them). */
const errorsOf = (program: Program, file: RealPath, files: ReadonlyArray<string>) =>
	Effect.try({
		try: () =>
			errorsIn([
				...program.getSyntacticDiagnostics(file),
				...program.getSemanticDiagnostics(files)
			]),
		catch: refused("the native compiler failed")
	})

/** The type errors among a mutant's errors: those it raises by more than leaving code unused or unreachable. */
const typeErrorsIn = (errors: ReadonlyArray<Diagnostic>) =>
	Arr.filter(errors, (error) => !UNUSED.has(error.code))

/** Whether a file is the repository's own, not an installed package's: only the repository's files are mutated. */
const isOwn = (file: string) => !Str.includes("/node_modules/")(file)

/**
 * What a file's readers can see of it: its declarations as the program emits them (the `.d.ts` text, maps left out),
 * which the native compiler gives for any file whatever the package's emit settings. It is the signature TypeScript's
 * own incremental build compares to decide whether a file's importers need checking again: a reader types the file only
 * through its declarations, so a mutant that leaves them as they were changes no reader's types. None when the emit
 * cannot stand for the file's types: skipped, empty, or with a diagnostic, as when an inferred type cannot be named and
 * is printed some other way.
 */
type Surface = Option.Option<string>

/** `file`'s surface in a program. */
const surfaceOf = (program: Program, file: RealPath) =>
	Effect.try({
		try: (): Surface => {
			const emitted = program.getDeclarationEmit([file])
			const texts = Arr.flatMap(Arr.fromIterable(emitted.outputFiles), ([name, output]) =>
				Str.endsWith(".map")(name) ? [] : [output.text]
			)
			return emitted.emitSkipped ||
				Arr.isReadonlyArrayNonEmpty(emitted.diagnostics) ||
				!Arr.isReadonlyArrayNonEmpty(texts)
				? Option.none()
				: Option.some(Arr.join(texts, "\n"))
		},
		catch: refused("the native compiler did not emit the file's declarations")
	})

/** Whether a mutant's surface is its file's own: both stand for their types, and they are the same text. */
const sameSurface = (before: Surface, after: Surface) =>
	Option.isSome(before) && Option.isSome(after) && before.value === after.value

/**
 * The repository's own files that `file` reads in a program, by any import, export or import type it holds, `import
 * type` included, as the compiler resolves it.
 */
const importsOf = (program: Program, file: ts.RootedFilePath): ReadonlyArray<string> =>
	Option.match(Option.fromUndefinedOr(program.getSourceFile(file)), {
		onNone: () => [],
		onSome: (source) =>
			Arr.flatMap(source.imports, (specifier) =>
				ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)
					? Option.match(
							Option.fromUndefinedOr(program.getResolvedModuleFromModuleSpecifier(specifier, file)),
							{
								onNone: () => [],
								onSome: (resolved) =>
									isOwn(resolved.resolvedFileName) ? [resolved.resolvedFileName] : []
							}
						)
					: []
			)
	})

/** Each own file's own imports, as read so far: each read in a program where that file held its own text. */
type Imports = ReadonlyMap<string, ReadonlyArray<string>>

/**
 * The files other than `file` whose types read it in `program`, a program that holds a mutant of `file`: those that
 * import it, directly or through others. A file's readers never go through its own imports, so they are the same in a
 * program that holds its mutant as in the unmutated one; every other file holds its own text there, so its imports
 * are read there once and kept (`imports`), and `file`'s are read later, in a program that holds its own text.
 */
const readersIn = (program: Program, file: RealPath, known: Imports) =>
	Effect.try({
		try: () => {
			const imports = new Map(known)
			for (const own of Arr.filter(program.getSourceFileNames(), isOwn)) {
				if (String(own) !== file && !imports.has(own)) {
					imports.set(own, importsOf(program, own))
				}
			}
			const importers = new Map<string, Array<string>>()
			for (const [importer, imported] of imports) {
				for (const one of imported) {
					const already = importers.get(one)
					if (already === undefined) {
						importers.set(one, [importer])
					} else {
						already.push(importer)
					}
				}
			}
			const reached = new Set<string>([file])
			const pending: Array<string> = [file]
			for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
				for (const importer of importers.get(next) ?? []) {
					if (!reached.has(importer)) {
						reached.add(importer)
						pending.push(importer)
					}
				}
			}
			reached.delete(file)
			return { readers: Arr.fromIterable(reached), imports }
		},
		catch: refused("the native compiler did not resolve the program's imports")
	})

/** What the unmutated program says of a file a run mutates: its text and its surface. */
type Unmutated = Readonly<{ text: string; surface: Surface }>

/**
 * A session's state: the live snapshot, the package as it is; what the unmutated program said of each file a mutant
 * replaced so far; and each own file's imports read so far.
 */
type Session = Readonly<{
	live: Snapshot
	files: ReadonlyMap<RealPath, Unmutated>
	imports: Imports
}>

/**
 * What a mutant's program finds: a type error in the mutant's own file; type errors in readers its changed surface
 * reaches, which only the unmutated program can tell the mutant's or the package's; or no type error.
 */
type Found =
	| Readonly<{ kind: "own" }>
	| Readonly<{ kind: "readers"; errors: Arr.NonEmptyReadonlyArray<Diagnostic> }>
	| Readonly<{ kind: "none" }>

/**
 * What a mutant of `file` finds in `program`, the program that holds it: its own file's type errors first; then, when
 * its surface is the unmutated file's, nothing more, since no reader can see it; else its readers' type errors. With
 * them, each own file's imports as read so far.
 */
const foundIn = (program: Program, file: RealPath, unmutated: Unmutated, known: Imports) =>
	Effect.gen(function* () {
		const errors = yield* errorsOf(program, file, [file])
		if (Arr.isReadonlyArrayNonEmpty(typeErrorsIn(errors))) {
			const own: Found = { kind: "own" }
			return { found: own, imports: known }
		}
		const surface = yield* surfaceOf(program, file)
		if (sameSurface(unmutated.surface, surface)) {
			const none: Found = { kind: "none" }
			return { found: none, imports: known }
		}
		const { readers, imports } = yield* readersIn(program, file, known)
		const readersErrors = yield* errorsOf(program, file, readers)
		const typeErrors = typeErrorsIn(readersErrors)
		const found: Found = Arr.isReadonlyArrayNonEmpty(typeErrors)
			? { kind: "readers", errors: typeErrors }
			: { kind: "none" }
		return { found, imports }
	})

/**
 * A session over the package whose tsconfig is `config`: the native compiler started for the enclosing scope, the
 * package opened in it, and the session's state, its live snapshot that package as it is.
 */
const sessionOf = (pkg: RealPath, config: string) =>
	Effect.gen(function* () {
		const api = yield* Effect.acquireRelease(
			Effect.try({
				try: () => new API({ cwd: pkg, fs: readOnlyHost }),
				catch: refused("the native compiler did not start")
			}),
			(started) =>
				Effect.sync(() => {
					started.close()
				})
		)
		const live = yield* Effect.try({
			try: () => api.createSnapshot({ openProjects: [config] }),
			catch: refused("the native compiler did not open the package")
		})
		return yield* Effect.acquireRelease(
			SynchronizedRef.make<Session>({ live, files: new Map(), imports: new Map() }),
			(state) =>
				Effect.flatMap(SynchronizedRef.get(state), (last) =>
					Effect.sync(() => {
						last.live[Symbol.dispose]()
					})
				)
		)
	})

/**
 * The package at `pkg` typed in one native compiler session for the enclosing scope, and whether a mutant's program has
 * a type error the unmutated program does not. A mutant with a type error is invalid: no one could commit it, so no
 * property need kill it.
 *
 * A mutant is checked in its own file, and in the files whose types read it (readersIn) only when it changes what they
 * read, its file's surface: a mutant of a function's body that leaves every declaration's type as it was (most of
 * them) costs the check of one file. Nothing is checked that no verdict reads: the first mutant of a file reads the
 * file's errors and surface in the unmutated program, which must find no error in it, and readers' errors under a
 * mutant are read again in the unmutated program, which must find none there either; either finding refuses the run.
 *
 * The compiler starts when the first mutant is checked, so a run that types no mutant never starts it, and it ends
 * with the enclosing scope. The session holds one live snapshot, the package as it is. A mutant's check updates it
 * with the mutant's text (an incremental update of that one file), reads what it needs, and updates that back to the
 * file's own text, each snapshot disposed as soon as its successor exists, so the session never holds more than two
 * programs however many mutants it checks. A snapshot derived from one unmutated snapshot kept for the session's life
 * instead holds every derivation's program state: a session over grizzle's engine grew its compiler past 19 GB in a
 * few hundred checks.
 */
export const typecheckerOf = Effect.fn("testing.mutate.typecheckerOf")(function* (pkg: RealPath) {
	const path = yield* Path.Path
	const fs = yield* FileSystem.FileSystem
	const config = path.join(pkg, "tsconfig.json")
	const scope = yield* Scope.Scope
	const opened = yield* Effect.cached(Scope.provide(scope)(sessionOf(pkg, config)))
	/** The live snapshot updated with `file` holding `text`, and the snapshot it came from disposed. */
	const succeeded = (snapshot: Snapshot, file: RealPath, text: string) =>
		Effect.try({
			try: () => {
				const next = snapshot.update({
					fileSystem: createFileSystemLayer([[file, text]]),
					ensurePrograms: true
				})
				snapshot[Symbol.dispose]()
				return next
			},
			catch: refused("the native compiler did not update the package")
		})
	/** What the unmutated program says of `file`, read once: the program must hold it, with no error in it. */
	const unmutatedOf = (state: Session, file: RealPath) =>
		Option.match(Option.fromUndefinedOr(state.files.get(file)), {
			onSome: Effect.succeed,
			onNone: () =>
				Effect.gen(function* () {
					const program = yield* programOf(state.live, config)
					const held = yield* Effect.try({
						try: () => program.getSourceFile(file),
						catch: refused("the native compiler failed")
					})
					if (held === undefined) {
						return yield* TypecheckRefused.make({
							message: `the program of ${config} holds no ${file}, so no mutant of it can be typed`
						})
					}
					const errors = yield* errorsOf(program, file, [file])
					if (Arr.isReadonlyArrayNonEmpty(errors)) {
						return yield* TypecheckRefused.make({
							message: `the unmutated package does not typecheck:\n${Arr.join(Arr.map(errors, diagnosticText), "\n")}`
						})
					}
					const text = yield* fs
						.readFileString(file)
						.pipe(Effect.mapError(refused(`reading ${file}`)))
					const surface = yield* surfaceOf(program, file)
					const unmutated: Unmutated = { text, surface }
					return unmutated
				})
		})
	return (mutated: MutatedFile): Effect.Effect<boolean, TypecheckRefused> =>
		Effect.flatMap(opened, (session) =>
			SynchronizedRef.modifyEffect(session, (state) =>
				Effect.gen(function* () {
					const unmutated = yield* unmutatedOf(state, mutated.target)
					const mutant = yield* succeeded(state.live, mutated.target, mutated.text)
					const typed = yield* programOf(mutant, config)
					const { found, imports } = yield* foundIn(typed, mutated.target, unmutated, state.imports)
					const restored = yield* succeeded(mutant, mutated.target, unmutated.text)
					if (found.kind === "readers") {
						const files = Arr.dedupe(
							Arr.flatMap(found.errors, (error) =>
								Option.toArray(Option.fromUndefinedOr(error.fileName))
							)
						)
						const unmutatedErrors = yield* Effect.flatMap(programOf(restored, config), (program) =>
							errorsOf(program, mutated.target, files)
						)
						if (Arr.isReadonlyArrayNonEmpty(unmutatedErrors)) {
							return yield* TypecheckRefused.make({
								message: `the unmutated package does not typecheck:\n${Arr.join(Arr.map(unmutatedErrors, diagnosticText), "\n")}`
							})
						}
					}
					const next: Session = {
						live: restored,
						files: new Map([...state.files, [mutated.target, unmutated]]),
						imports
					}
					return [found.kind !== "none", next] as const
				})
			)
		)
})
