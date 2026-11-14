import { Array as Arr, Effect, FileSystem, Option, Order, Result, String as Str } from "effect"
import type { Invocation } from "#shared/arguments.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"
import { fixtureMismatchesOf } from "#shared/fixtures.ts"
import { gitFilesUnder } from "#shared/git.ts"
import { covers, isGeneratedPath, isVendoredPath, type TailwindApp } from "#shared/repository.ts"
import { selectFiles } from "#shared/selection.ts"
import {
	type AppStyleOptions,
	appPathsOf,
	FIXTURE_OPTIONS,
	type RuleOptions,
	RUNTIME_FIXTURE_OPTIONS,
	stylesheetPathsOf
} from "#style/options.ts"
import type {
	FixtureCase,
	OwnStyleRules,
	OwnStyleRun,
	OwnStyleSet,
	SourceReader
} from "#style/own.ts"
import { isNamedBy, isNamedByAny } from "#style/paths.ts"
import {
	SECOND_STYLESHEET,
	type SheetRole,
	sheetRolesOf,
	stylesheet
} from "#style/rules/stylesheet.ts"
import { type SheetRule, STYLE_RULES } from "#style/types.ts"

/**
 * The style engine: one app's run and the fixture runs. A run reads the app's stylesheets and HTML files as git lists
 * them, and the files the repository's own style rules name, as text: it opens no TypeScript program and loads no
 * design system. It holds every stylesheet to the contract the app's options give it, refuses standalone HTML, and
 * runs the own rules the app's options list, which read their files once before any of them reports. The class,
 * markup and paint rules are oxlint's, which the preset runs on the app's files.
 */

/** Standalone HTML is not a maintained application surface: the app renders JSX. */
const STANDALONE_HTML = "Standalone HTML is not a maintained application surface; use JSX."

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be read`, cause })

const readText = (file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readFileString(file).pipe(Effect.mapError(inspectionFailure(file)))
	)

const isStylesheetPath = Str.endsWith(".css")

const isHtmlPath = (file: string): boolean =>
	Str.endsWith(".html")(file) || Str.endsWith(".htm")(file)

/** What one run reads: the stylesheets and HTML files it reports on and the stylesheets it reads as an app's own,
 * every file the run knows and every path the options name, the stylesheet options, the repository's own style rules,
 * and which files the run reports on. */
type StyleRun = Readonly<{
	stylesheets: ReadonlyArray<string>
	appStylesheets: ReadonlyArray<string>
	html: ReadonlyArray<string>
	known: ReadonlyArray<string>
	named: ReadonlyArray<string>
	options: RuleOptions
	own: ReadonlyArray<OwnStyleSet>
	isReported: (file: string) => boolean
}>

/** A finding about a whole file, which is not one the app maintains. */
const fileFinding =
	(rule: SheetRule, message: string) =>
	(file: string): Finding => ({ file, line: 1, column: 1, rule, message })

/** A stylesheet with the one role the options give it, none when they name it nowhere. A sheet they give two roles
 * is a failure, never a guess. */
const roleOf =
	(run: StyleRun) =>
	(
		file: string
	): Effect.Effect<Readonly<{ file: string; role: Option.Option<SheetRole> }>, DevtoolFailure> => {
		const [role, ...others] = sheetRolesOf({
			file,
			isApp: Arr.contains(run.appStylesheets, file),
			options: run.options.stylesheet
		})
		return Arr.isReadonlyArrayNonEmpty(others)
			? Effect.fail(
					DevtoolFailure.make({
						detail: `${file} has more than one role among the app's stylesheet and the style options' scoped and passthrough sheets`
					})
				)
			: Effect.succeed({ file, role: Option.fromUndefinedOr(role) })
	}

/** The stylesheet contract over one sheet the options give a role, with what the repository's own rules add to it:
 * their theme namespaces, and their additions to this sheet. */
const sheetFindingsOf = (
	run: StyleRun,
	prepared: ReadonlyArray<OwnStyleRun>,
	sheet: Readonly<{ file: string; role: SheetRole }>
) =>
	Effect.map(readText(sheet.file), (text) =>
		Arr.map(
			stylesheet({
				text,
				role: sheet.role,
				options: run.options.stylesheet,
				extensions: {
					namespaces: Arr.flatMap(prepared, (own) => own.namespaces),
					sheets: Arr.filter(
						Arr.flatMap(prepared, (own) => own.stylesheets),
						(extension) => isNamedBy(extension.sheet)(sheet.file)
					)
				}
			}),
			(said): Finding => ({
				file: sheet.file,
				line: said.at.line,
				column: said.at.column,
				rule: "stylesheet",
				message: said.message
			})
		)
	)

/** The reader of the one file the run knows that a path names. */
const readerOf =
	(fs: FileSystem.FileSystem, known: ReadonlyArray<string>): SourceReader =>
	(path) => {
		const [first, ...others] = Arr.filter(known, isNamedBy(path))
		return first !== undefined && !Arr.isReadonlyArrayNonEmpty(others)
			? fs.readFileString(first).pipe(
					Effect.mapBoth({
						onFailure: inspectionFailure(first),
						onSuccess: (text) => ({ file: first, text })
					})
				)
			: Effect.fail(
					DevtoolFailure.make({
						detail: `The style options name ${path}, which ${first === undefined ? "no file the style linter reads" : "more than one file"} matches`
					})
				)
	}

/** Every rule over a run: the stylesheet contract over every stylesheet the options give a role, every other
 * stylesheet and HTML file, and what the repository's own rules find. */
const styleFindingsOf = Effect.fn("styleFindingsOf")(function* (run: StyleRun) {
	const unmatched = Arr.filter(run.named, (path) => !Arr.some(run.known, isNamedBy(path)))
	if (Arr.isReadonlyArrayNonEmpty(unmatched)) {
		return yield* DevtoolFailure.make({
			detail: `The style options name ${Arr.join(unmatched, ", ")}, which no file the style linter reads matches`
		})
	}
	const fs = yield* FileSystem.FileSystem
	const read = readerOf(fs, run.known)
	const prepared = yield* Effect.forEach(
		run.own,
		(own) => own.prepare({ read, stylesheet: run.options.stylesheet }),
		{ concurrency: 1 }
	)
	const sheets = yield* Effect.forEach(run.stylesheets, roleOf(run), { concurrency: 1 })
	const unnamed = Arr.filterMap(sheets, (sheet) =>
		Option.isNone(sheet.role) ? Result.succeed(sheet.file) : Result.failVoid
	)
	const sheetFindings = yield* Effect.forEach(
		Arr.filterMap(sheets, (sheet) =>
			Option.match(sheet.role, {
				onNone: () => Result.failVoid,
				onSome: (role) => Result.succeed({ file: sheet.file, role })
			})
		),
		(sheet) => sheetFindingsOf(run, prepared, sheet),
		{ concurrency: 1 }
	)
	const ownFindings = Arr.filter(
		Arr.flatMap(prepared, (own) => own.findings),
		(finding) => run.isReported(finding.file)
	)
	return [
		...Arr.flatten(sheetFindings),
		...ownFindings,
		...Arr.map(unnamed, fileFinding("stylesheet", SECOND_STYLESHEET)),
		...Arr.map(run.html, fileFinding("markup", STANDALONE_HTML))
	]
})

/** An app's options as the engine may run them: the repository's own rules report under ids no shared rule and no
 * other of the app's own rule sets uses, and every exception names a rule the app runs, the style linter's, oxlint's
 * or its own. */
const checkedOptions = (
	input: Readonly<{ app: string; options: AppStyleOptions }>
): Effect.Effect<AppStyleOptions, DevtoolFailure> => {
	const ownIds = Arr.flatMap(input.options.own, (own) => own.ids)
	const taken = Arr.filter(
		Arr.dedupe(ownIds),
		(id) => Arr.contains(STYLE_RULES, id) || Arr.filter(ownIds, (other) => other === id).length > 1
	)
	if (Arr.isReadonlyArrayNonEmpty(taken)) {
		return Effect.fail(
			DevtoolFailure.make({
				detail: `The own style rules of ${input.app} report under ids a shared rule or another of its rule sets already uses: ${Arr.join(taken, ", ")}`
			})
		)
	}
	const unknown = Arr.filter(
		input.options.exceptions,
		(exception) =>
			!Arr.contains(STYLE_RULES, exception.rule) && !Arr.contains(ownIds, exception.rule)
	)
	return Arr.isReadonlyArrayNonEmpty(unknown)
		? Effect.fail(
				DevtoolFailure.make({
					detail: `The style options of ${input.app} list exceptions for rules it does not run: ${Arr.join(
						Arr.map(unknown, (exception) => exception.rule),
						", "
					)}`
				})
			)
		: Effect.succeed(input.options)
}

/**
 * One app's findings: its stylesheets and HTML files as git lists them, vendored and generated files aside, narrowed
 * to the paths the command line names, less the app's exceptions. The files outside the app that the own rules'
 * options name (a table another workspace package owns) are reported on too. `name` names the app in a failure: its
 * package root relative to the repository's. The options' entry point must be the stylesheet components.json names,
 * which the class rules load the design system from, and their vendored directory the one its aliases.ui resolves
 * to.
 */
export const appFindings = Effect.fn("appFindings")(function* (
	input: Readonly<{
		app: TailwindApp
		name: string
		root: string
		invocation: Invocation
		options: AppStyleOptions
	}>
) {
	const { app, invocation } = input
	const options = yield* checkedOptions({ app: input.name, options: input.options })
	if (`${input.root}/${options.entryPoint}` !== app.stylesheet) {
		return yield* DevtoolFailure.make({
			detail: `The style options of ${input.name} name ${options.entryPoint} as the app's entry point, and components.json names ${app.stylesheet}`
		})
	}
	if (`${input.root}/${options.vendored}` !== `${app.vendored}/`) {
		return yield* DevtoolFailure.make({
			detail: `The style options of ${input.name} name ${options.vendored} as the app's vendored components, and components.json's aliases.ui resolves to ${app.vendored}/`
		})
	}
	const own = Arr.map(options.own, (rules) => rules.set)
	const ownPaths = Arr.flatMap(own, (set) => set.paths)
	const isVendored = isVendoredPath([app])
	const listed = yield* gitFilesUnder(input.root)
	const tracked = Arr.filter(listed, (file) => !isVendored(file) && !isGeneratedPath(file))
	const inApp = Arr.filter(tracked, (file) => covers({ selected: app.root, file }))
	const outside = Arr.filter(
		tracked,
		(file) => isNamedByAny(ownPaths)(file) && !covers({ selected: app.root, file })
	)
	const selected = yield* selectFiles({
		available: [...inApp, ...outside],
		paths: invocation.paths
	})
	const isSelected = (file: string): boolean => Arr.contains(selected, file)
	const linted = yield* styleFindingsOf({
		stylesheets: Arr.filter(inApp, (file) => isStylesheetPath(file) && isSelected(file)),
		appStylesheets: [app.stylesheet],
		html: Arr.filter(inApp, (file) => isHtmlPath(file) && isSelected(file)),
		known: tracked,
		named: [...appPathsOf(options), ...ownPaths],
		options,
		own,
		isReported: isSelected
	})
	return Arr.filter(
		linted,
		(finding) =>
			!Arr.some(
				options.exceptions,
				(exception) =>
					exception.rule === finding.rule && isNamedByAny(exception.files)(finding.file)
			)
	)
})

/** The shared rules' fixtures: the stylesheet rule's under stylesheet/, and the class rules' under classes/, which
 * oxlint proves. */
export const FIXTURES_ROOT = `${import.meta.dirname}/fixtures`

/** A set of fixtures read in one run: its name in the output, its directory, which of its stylesheets it reads (by
 * their path relative to the directory), the stylesheet options and the own rules it runs under, and its cases. */
type FixtureSuite = Readonly<{
	name: string
	root: string
	sheets: (relative: string) => boolean
	options: RuleOptions
	own: ReadonlyArray<OwnStyleSet>
	cases: ReadonlyArray<FixtureCase>
}>

const isSharedSheet = Str.startsWith("stylesheet/")

/** The stylesheet rule's suite: a case per role a sheet can have (the app's own, a scoped sheet, a passthrough, and
 * none), and three for layered imports: an app sheet that orders its layers, so its layered import is admitted, one
 * that does not, so none is, and a scoped sheet, which may neither order layers nor import. */
const SHARED_SUITE: FixtureSuite = {
	name: "style",
	root: FIXTURES_ROOT,
	sheets: isSharedSheet,
	options: FIXTURE_OPTIONS,
	own: [],
	cases: Arr.map(
		["app", "app/layered", "app/unordered", "scoped", "scoped/layered", "passthrough", "unnamed"],
		(role): FixtureCase => ({ directory: `stylesheet/${role}`, rule: "stylesheet" })
	)
}

/** The stylesheet rule under a runtime layer: an app sheet whose `@layer` statement names it first, beside Tailwind's
 * layers and the layered import, is admitted, and one that leaves it out or names it later is refused. It reads the
 * shared fixtures' tree, so its one case is the only directory it judges. */
const RUNTIME_SUITE: FixtureSuite = {
	name: "style, runtime layers",
	root: FIXTURES_ROOT,
	sheets: isSharedSheet,
	options: RUNTIME_FIXTURE_OPTIONS,
	own: [],
	cases: [{ directory: "stylesheet/app/runtime", rule: "stylesheet" }]
}

/** An own rule set's suite: a case for each id it reports under, in the id's directory, and the set's other cases.
 * It reads every stylesheet outside support/. */
const ownSuiteOf = (rules: OwnStyleRules): FixtureSuite => ({
	name: `style ${rules.name}`,
	root: rules.fixtures.directory,
	sheets: (relative) => !Str.startsWith("support/")(relative),
	options: rules.fixtures.style,
	own: [rules.fixtureSet],
	cases: [...Arr.map(rules.ids, (rule) => ({ directory: rule, rule })), ...rules.fixtures.cases]
})

const extensionOf = (rule: string): string => (rule === "stylesheet" ? ".css" : ".tsx")

/** One suite's mismatches. The stylesheets it reads under stylesheet/app/ are read as the app's own. */
const suiteMismatchesOf = Effect.fn("suiteMismatchesOf")(function* (suite: FixtureSuite) {
	const fs = yield* FileSystem.FileSystem
	const entries = yield* fs
		.readDirectory(suite.root, { recursive: true })
		.pipe(Effect.mapError(inspectionFailure(suite.root)))
	const files = Arr.map(Arr.sort(entries, Order.String), (relative) => `${suite.root}/${relative}`)
	const cssFiles = Arr.filterMap(Arr.sort(entries, Order.String), (relative) =>
		isStylesheetPath(relative) && suite.sheets(relative)
			? Result.succeed(`${suite.root}/${relative}`)
			: Result.failVoid
	)
	const findings = yield* styleFindingsOf({
		stylesheets: cssFiles,
		appStylesheets: Arr.filter(cssFiles, (file) =>
			covers({ selected: `${suite.root}/stylesheet/app`, file })
		),
		html: [],
		known: files,
		named: [...stylesheetPathsOf(suite.options), ...Arr.flatMap(suite.own, (set) => set.paths)],
		options: suite.options,
		own: suite.own,
		isReported: () => true
	})
	const fixtureFiles = Arr.flatMap(suite.cases, (fixtureCase) =>
		Arr.map(
			["violating", "clean"],
			(role) => `${suite.root}/${fixtureCase.directory}/${role}${extensionOf(fixtureCase.rule)}`
		)
	)
	const read = yield* Effect.forEach(
		Arr.filter(fixtureFiles, (file) => Arr.contains(files, file)),
		(file) => Effect.map(readText(file), (text) => [file, text] as const),
		{ concurrency: 1 }
	)
	const texts = new Map(read)
	return Arr.flatMap(suite.cases, (fixtureCase) =>
		fixtureMismatchesOf({
			root: suite.root,
			extensionOf: () => extensionOf(fixtureCase.rule),
			rules: [fixtureCase.directory],
			runOf: ({ file }) =>
				Option.map(Option.fromUndefinedOr(texts.get(file)), (text) => ({
					text,
					reported: Arr.filterMap(findings, (finding) =>
						finding.file === file && finding.rule === fixtureCase.rule
							? Result.succeed(finding.line)
							: Result.failVoid
					)
				}))
		})
	)
})

/** The fixture suites to run, all at once: the stylesheet rule's (and its run under a runtime layer) when the dev tools
 * run as the repository's own package, and each own rule set's; each with its name, its root, how many rules it
 * proves and its mismatches. */
export const fixtureRuns = (
	input: Readonly<{ shared: boolean; own: ReadonlyArray<OwnStyleRules> }>
) =>
	Effect.forEach(
		[...(input.shared ? [SHARED_SUITE, RUNTIME_SUITE] : []), ...Arr.map(input.own, ownSuiteOf)],
		(suite) =>
			Effect.map(suiteMismatchesOf(suite), (mismatches) => ({
				name: suite.name,
				root: suite.root,
				rules: Arr.dedupe(Arr.map(suite.cases, (fixtureCase) => fixtureCase.rule)).length,
				mismatches
			})),
		{ concurrency: "unbounded" }
	)
