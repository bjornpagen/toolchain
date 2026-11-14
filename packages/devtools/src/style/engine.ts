import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Result,
	String as Str
} from "effect"
import type * as ts from "typescript/ast"
import type { Project } from "typescript/sync"
import type { Invocation } from "#shared/arguments.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import { type Finding, findingAt, type Report } from "#shared/finding.ts"
import { fixtureMismatchesOf } from "#shared/fixtures.ts"
import { gitFilesUnder } from "#shared/git.ts"
import { type RoundTrip, withProgram } from "#shared/native-api.ts"
import {
	covers,
	isGeneratedPath,
	isTypeScriptPath,
	isVendoredPath,
	type TailwindApp
} from "#shared/repository.ts"
import { selectFiles } from "#shared/selection.ts"
import { prepareSemantics } from "#shared/semantic.ts"
import { classExtractor } from "#style/class-extractor.ts"
import { type DesignSystem, loadDesignSystem } from "#style/design-system.ts"
import { type AppStyleOptions, FIXTURE_OPTIONS, pathsOf, type RuleOptions } from "#style/options.ts"
import type {
	FixtureCase,
	OwnStyleRules,
	OwnStyleRun,
	OwnStyleSet,
	SourceFinder
} from "#style/own.ts"
import { isNamedBy, isNamedByAny } from "#style/paths.ts"
import { noConflictingClasses } from "#style/rules/class-lists.ts"
import { noInvalidColor } from "#style/rules/colors.ts"
import { markup, STANDALONE_HTML } from "#style/rules/markup.ts"
import { noArbitraryValue } from "#style/rules/no-arbitrary-value.ts"
import { noSvgPaint } from "#style/rules/no-svg-paint.ts"
import { noUnresolvedClass } from "#style/rules/no-unresolved-class.ts"
import {
	SECOND_STYLESHEET,
	type SheetRole,
	sheetRolesOf,
	stylesheet
} from "#style/rules/stylesheet.ts"
import { type ClassRule, STYLE_RULES, type StyleRule } from "#style/types.ts"

/**
 * The style engine: one app's run and the fixture runs. A run reads the app's program with its own checker against
 * the full Tailwind v4 design system the app's stylesheet defines, and runs the shared rules and the repository's own
 * style rules the app's options list, which read the program once before any of them reports.
 */

const CLASS_RULES: ReadonlyArray<Readonly<{ id: string; check: ClassRule }>> = [
	{ id: "no-unresolved-class", check: noUnresolvedClass },
	{ id: "no-conflicting-classes", check: noConflictingClasses },
	{ id: "no-invalid-color", check: noInvalidColor },
	{ id: "no-arbitrary-value", check: noArbitraryValue }
]

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be read`, cause })

/** The design system a stylesheet defines, compiled from its text with imports resolved from its directory. */
const designSystemAt = Effect.fn("designSystemAt")(function* (entry: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const css = yield* fs.readFileString(entry).pipe(Effect.mapError(inspectionFailure(entry)))
	if (!Str.isNonEmpty(Str.trim(css))) {
		return yield* DevtoolFailure.make({
			detail: `${entry}, the stylesheet the design system compiles from, is empty`
		})
	}
	return yield* loadDesignSystem({ css, base: path.dirname(entry), path: entry })
})

const readText = (file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readFileString(file).pipe(Effect.mapError(inspectionFailure(file)))
	)

const readTexts = (files: ReadonlyArray<string>) =>
	Effect.forEach(files, (file) => Effect.map(readText(file), (text) => ({ file, text })))

const isStylesheetPath = Str.endsWith(".css")

const isHtmlPath = (file: string): boolean =>
	Str.endsWith(".html")(file) || Str.endsWith(".htm")(file)

/** The program's own source files that `keep` admits, in name order, generated and declaration files aside. */
const programSourcesOf = (project: Project, keep: (file: string) => boolean) =>
	Effect.try({
		try: () =>
			Arr.filterMap(
				Arr.sort(project.program.getSourceFileNames(), Order.String),
				(file): Result.Result<ts.SourceFile, void> => {
					const sourceFile =
						!isGeneratedPath(file) && keep(file) ? project.program.getSourceFile(file) : undefined
					return sourceFile === undefined || sourceFile.isDeclarationFile
						? Result.failVoid
						: Result.succeed(sourceFile)
				}
			),
		catch: (cause) =>
			DevtoolFailure.make({ detail: "The program's source files could not be read", cause })
	})

/** What one run reads: the program, its session's round trip, every source of it and the ones the rules report on,
 * the stylesheets and HTML files it reports on and the stylesheets it reads as an app's own, every file the run knows
 * and every path the options name, the app's class helper, the design system, the shared rules' options, the
 * repository's own style rules, and which files the run reports on. */
type StyleRun = Readonly<{
	project: Project
	roundTrip: RoundTrip
	programSources: ReadonlyArray<ts.SourceFile>
	files: ReadonlyArray<ts.SourceFile>
	stylesheets: ReadonlyArray<string>
	appStylesheets: ReadonlyArray<string>
	html: ReadonlyArray<string>
	known: ReadonlyArray<string>
	named: ReadonlyArray<string>
	classHelper: string
	system: DesignSystem
	options: RuleOptions
	own: ReadonlyArray<OwnStyleSet>
	isReported: (file: string) => boolean
}>

const stamped =
	(rule: string) =>
	(report: Report): Finding =>
		findingAt({ sourceFile: report.node.getSourceFile(), rule, report })

/** A finding about a whole file, which is not one the app maintains. */
const fileFinding =
	(rule: StyleRule, message: string) =>
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

/** The finder of the one program source a path names. */
const finderOf =
	(programSources: ReadonlyArray<ts.SourceFile>): SourceFinder =>
	(path) => {
		const [first, ...others] = Arr.filter(programSources, (sourceFile) =>
			isNamedBy(path)(sourceFile.fileName)
		)
		return first !== undefined && !Arr.isReadonlyArrayNonEmpty(others)
			? Effect.succeed(first)
			: Effect.fail(
					DevtoolFailure.make({
						detail: `The style options name ${path}, which ${first === undefined ? "no source of the program" : "more than one source"} matches`
					})
				)
	}

/** Every rule over a run: what the extractor found unreadable, the markup and paint rules over every source, every
 * class rule over every class list, the stylesheet contract over every stylesheet the options give a role, every
 * other stylesheet and HTML file, and what the repository's own rules report on the program. */
const styleFindingsOf = Effect.fn("styleFindingsOf")(function* (run: StyleRun) {
	const unmatched = Arr.filter(run.named, (path) => !Arr.some(run.known, isNamedBy(path)))
	if (Arr.isReadonlyArrayNonEmpty(unmatched)) {
		return yield* DevtoolFailure.make({
			detail: `The style options name ${Arr.join(unmatched, ", ")}, which no file the style linter reads matches`
		})
	}
	const { checker } = run.project
	const find = finderOf(run.programSources)
	const prepared = yield* Effect.forEach(run.own, (own) =>
		own.prepare({ checker, find, stylesheet: run.options.stylesheet })
	)
	const read = yield* Effect.try({
		try: () => {
			const extract = classExtractor({
				checker,
				classHelper: run.classHelper,
				bridges: run.options.markup.styleBridges
			})
			return Arr.map(run.files, (sourceFile) => {
				const semantics = prepareSemantics({ sourceFile, checker, roundTrip: run.roundTrip })
				const classes = extract({ sourceFile, semantics })
				return {
					lists: classes.lists,
					findings: [
						...classes.findings,
						...Arr.map(markup({ sourceFile, options: run.options.markup }), stamped("markup")),
						...Arr.map(noSvgPaint({ sourceFile, semantics }), stamped("no-svg-paint"))
					]
				}
			})
		},
		catch: (cause) =>
			DevtoolFailure.make({ detail: "The style rules failed to read the sources", cause })
	})
	const lists = yield* Effect.forEach(
		Arr.flatMap(read, (file) => file.lists),
		run.system.explain
	)
	const classRules = [...CLASS_RULES, ...Arr.flatMap(prepared, (own) => own.classRules)]
	const classFindings = Arr.flatMap(lists, (list) =>
		Arr.flatMap(classRules, (rule) =>
			Arr.map(rule.check({ list, theme: run.system.theme }), (verdict): Finding => {
				const located = {
					file: verdict.token.file,
					line: verdict.token.line,
					column: verdict.token.column,
					rule: rule.id,
					message: verdict.message
				}
				return verdict.suggestion === undefined
					? located
					: { ...located, suggestion: verdict.suggestion }
			})
		)
	)
	const sheets = yield* Effect.forEach(run.stylesheets, roleOf(run))
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
		(sheet) => sheetFindingsOf(run, prepared, sheet)
	)
	const ownFindings = Arr.filter(
		Arr.map(
			Arr.flatMap(prepared, (own) => own.reports),
			({ rule, report }) => stamped(rule)(report)
		),
		(finding) => run.isReported(finding.file)
	)
	return [
		...Arr.flatMap(read, (file) => file.findings),
		...classFindings,
		...Arr.flatten(sheetFindings),
		...ownFindings,
		...Arr.map(unnamed, fileFinding("stylesheet", SECOND_STYLESHEET)),
		...Arr.map(run.html, fileFinding("markup", STANDALONE_HTML))
	]
})

/** An app's options as the engine may run them: the repository's own rules report under ids no shared rule and no
 * other of the app's own rule sets uses, and every exception names a rule the app runs. */
const checkedOptions = (
	input: Readonly<{ app: string; options: AppStyleOptions }>
): Effect.Effect<AppStyleOptions, DevtoolFailure> => {
	const ownIds = Arr.flatMap(input.options.own, (own) => own.ids)
	const taken = Arr.filter(
		Arr.dedupe(ownIds),
		(id) =>
			Arr.contains<string>(STYLE_RULES, id) ||
			Arr.filter(ownIds, (other) => other === id).length > 1
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
			!Arr.contains<string>(STYLE_RULES, exception.rule) && !Arr.contains(ownIds, exception.rule)
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
 * One app's findings: its program's sources under the app, its stylesheets and HTML files as git lists them, vendored
 * and generated files aside, narrowed to the paths the command line names, less the app's exceptions. The program
 * sources outside the app that the own rules' options name (a table another workspace package owns) are reported on
 * too. `app` names the app in a failure: its package root relative to the repository's.
 */
export const appFindings = Effect.fn("appFindings")(function* (
	input: Readonly<{
		app: TailwindApp
		name: string
		invocation: Invocation
		options: AppStyleOptions
	}>
) {
	const { app, invocation } = input
	const options = yield* checkedOptions({ app: input.name, options: input.options })
	const own = Arr.map(options.own, (rules) => rules.set)
	const ownPaths = Arr.flatMap(own, (set) => set.paths)
	const isVendored = isVendoredPath([app])
	const system = yield* designSystemAt(app.stylesheet)
	const tracked = yield* gitFilesUnder(app.root)
	const listed = Arr.filter(tracked, (file) => !isVendored(file) && !isGeneratedPath(file))
	const css = Arr.filter(listed, isStylesheetPath)
	const html = Arr.filter(listed, isHtmlPath)
	const linted = yield* withProgram(
		{
			config: `${app.root}/tsconfig.json`,
			extraFiles: Arr.filter(invocation.paths, isTypeScriptPath)
		},
		(project, roundTrip) =>
			Effect.gen(function* () {
				const programSources = yield* programSourcesOf(project, (file) => !isVendored(file))
				const sources = Arr.filter(programSources, (sourceFile) =>
					covers({ selected: app.root, file: sourceFile.fileName })
				)
				const outside = Arr.filter(
					Arr.map(programSources, (sourceFile) => sourceFile.fileName),
					(file) => isNamedByAny(ownPaths)(file) && !covers({ selected: app.root, file })
				)
				const selected = yield* selectFiles({
					available: [
						...Arr.map(sources, (sourceFile) => sourceFile.fileName),
						...outside,
						...css,
						...html
					],
					paths: invocation.paths
				})
				const isSelected = (file: string): boolean => Arr.contains(selected, file)
				return yield* styleFindingsOf({
					project,
					roundTrip,
					programSources,
					files: Arr.filter(sources, (sourceFile) => isSelected(sourceFile.fileName)),
					stylesheets: Arr.filter(css, isSelected),
					appStylesheets: [app.stylesheet],
					html: Arr.filter(html, isSelected),
					known: [...Arr.map(programSources, (sourceFile) => sourceFile.fileName), ...css, ...html],
					named: [
						...Arr.flatMap(options.exceptions, (exception) => exception.files),
						...pathsOf(options),
						...ownPaths
					],
					classHelper: app.classHelper,
					system,
					options,
					own,
					isReported: isSelected
				})
			})
	)
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

/** The shared rules' fixtures: each rule's directory compiles in one program against the stylesheet and class helper
 * in support/; no other tool reads them. */
export const FIXTURES_ROOT = `${import.meta.dirname}/fixtures`

/** A set of fixtures that compile in one program: its name in the output, its directory, the shared rules' options
 * and the own rules it runs under, and its cases. */
type FixtureSuite = Readonly<{
	name: string
	root: string
	options: RuleOptions
	own: ReadonlyArray<OwnStyleSet>
	cases: ReadonlyArray<FixtureCase>
}>

/** The shared rules' suite. The stylesheet rule has a case per role a sheet can have (the app's own, a scoped sheet,
 * a passthrough, and none), and three for layered imports: an app sheet that orders its layers, so its layered import
 * is admitted, one that does not, so none is, and a scoped sheet, which may neither order layers nor import. */
const SHARED_SUITE: FixtureSuite = {
	name: "style",
	root: FIXTURES_ROOT,
	options: FIXTURE_OPTIONS,
	own: [],
	cases: [
		...Arr.filterMap(STYLE_RULES, (rule): Result.Result<FixtureCase, void> =>
			rule === "stylesheet" ? Result.failVoid : Result.succeed({ directory: rule, rule })
		),
		...Arr.map(
			["app", "app/layered", "app/unordered", "scoped", "scoped/layered", "passthrough", "unnamed"],
			(role): FixtureCase => ({ directory: `stylesheet/${role}`, rule: "stylesheet" })
		)
	]
}

/** An own rule set's suite: a case for each id it reports under, in the id's directory, and the set's other cases. */
const ownSuiteOf = (rules: OwnStyleRules): FixtureSuite => ({
	name: `style ${rules.name}`,
	root: rules.fixtures.directory,
	options: rules.fixtures.style,
	own: [rules.fixtureSet],
	cases: [...Arr.map(rules.ids, (rule) => ({ directory: rule, rule })), ...rules.fixtures.cases]
})

/** One suite's mismatches. Every stylesheet outside support/ is read, the ones under stylesheet/app/ as the app's
 * own; support/theme.css is the design system and support/cn.ts the class helper. */
const suiteMismatchesOf = Effect.fn("suiteMismatchesOf")(function* (suite: FixtureSuite) {
	const fs = yield* FileSystem.FileSystem
	const support = `${suite.root}/support`
	const system = yield* designSystemAt(`${support}/theme.css`)
	const entries = yield* fs
		.readDirectory(suite.root, { recursive: true })
		.pipe(Effect.mapError(inspectionFailure(suite.root)))
	const cssFiles = Arr.sort(
		Arr.filterMap(entries, (relative) =>
			isStylesheetPath(relative) && !Str.startsWith("support/")(relative)
				? Result.succeed(`${suite.root}/${relative}`)
				: Result.failVoid
		),
		Order.String
	)
	const sheetTexts = yield* readTexts(cssFiles)
	return yield* withProgram(
		{ config: `${suite.root}/tsconfig.json`, extraFiles: [] },
		(project, roundTrip) =>
			Effect.gen(function* () {
				const files = yield* programSourcesOf(project, (file) =>
					covers({ selected: suite.root, file })
				)
				const findings = yield* styleFindingsOf({
					project,
					roundTrip,
					programSources: files,
					files,
					stylesheets: cssFiles,
					appStylesheets: Arr.filter(cssFiles, (file) =>
						covers({ selected: `${suite.root}/stylesheet/app`, file })
					),
					html: [],
					known: [...Arr.map(files, (sourceFile) => sourceFile.fileName), ...cssFiles],
					named: [...pathsOf(suite.options), ...Arr.flatMap(suite.own, (set) => set.paths)],
					classHelper: `${support}/cn.ts`,
					system,
					options: suite.options,
					own: suite.own,
					isReported: () => true
				})
				const texts = new Map([
					...Arr.map(files, (sourceFile) => [sourceFile.fileName, sourceFile.text] as const),
					...Arr.map(sheetTexts, (sheet) => [sheet.file, sheet.text] as const)
				])
				return Arr.flatMap(suite.cases, (fixtureCase) =>
					fixtureMismatchesOf({
						root: suite.root,
						extensionOf: () => (fixtureCase.rule === "stylesheet" ? ".css" : ".tsx"),
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
	)
})

/** The fixture suites to run, all at once: the shared rules' when the dev tools run as the repository's own package,
 * and each own rule set's; each with its name, its root, how many rules it proves and its mismatches. */
export const fixtureRuns = (
	input: Readonly<{ shared: boolean; own: ReadonlyArray<OwnStyleRules> }>
) =>
	Effect.forEach(
		[...(input.shared ? [SHARED_SUITE] : []), ...Arr.map(input.own, ownSuiteOf)],
		(suite) =>
			Effect.map(suiteMismatchesOf(suite), (mismatches) => ({
				name: suite.name,
				root: suite.root,
				rules: Arr.dedupe(Arr.map(suite.cases, (fixtureCase) => fixtureCase.rule)).length,
				mismatches
			})),
		{ concurrency: "unbounded" }
	)
