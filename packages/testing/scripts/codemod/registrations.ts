import { Array as Arr, Option, Record as Rec, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Plugin } from "#codemod/plugin.ts"
import type { Finding, Reason } from "#codemod/report.ts"
import {
	calleeOf,
	isDeclaration,
	lineOf,
	type Parsed,
	stringValueOf,
	textOf,
	unparenthesized
} from "#codemod/syntax.ts"

/**
 * The toolchain's old search API, by the modules a module imports each part from: the testing package's exports, or,
 * inside the testing package, its own subpath imports.
 */
export const OLD = {
	explore: ["@bjornpagen/testing/explore", "#explore.ts"],
	features: ["@bjornpagen/testing/features", "#features.ts"],
	searched: ["@bjornpagen/testing/vitest", "#vitest/searched.ts"],
	sense: ["@bjornpagen/testing/sense", "#sense.ts"],
	gen: ["@bjornpagen/testing/gen", "#gen.ts"]
} as const

/** Vitest's modules and the old search API's Vitest adapter: a converted module imports none of them. */
export const VITEST_MODULES: ReadonlyArray<string> = [
	"vitest",
	"@effect/vitest",
	"@effect/vitest/utils",
	...OLD.searched
]

/** Where a converted module imports the new API from: the testing package's exports, or its own subpath imports. */
export type Api = Readonly<{ property: string; gen: string; features: string; assert: string }>

const PACKAGE_API: Api = {
	property: "@bjornpagen/testing/property",
	gen: "@bjornpagen/testing/gen",
	features: "@bjornpagen/testing/features",
	assert: "@bjornpagen/testing/assert"
}

const INTERNAL_API: Api = {
	property: "#property.ts",
	gen: "#gen.ts",
	features: "#features.ts",
	assert: "#assert.ts"
}

/** The API a module imports from: the testing package's own subpath imports when it reads the old API through them. */
export const apiOf = (imports: ReadonlyMap<string, Binding>): Api =>
	Arr.some([...imports.values()], (binding) =>
		Arr.some(
			Rec.values(OLD),
			(modules: ReadonlyArray<string>) =>
				Arr.contains(modules, binding.module) && Str.startsWith("#")(binding.module)
		)
	)
		? INTERNAL_API
		: PACKAGE_API

/** A step that either builds its value or refuses with every reason it met. */
export type Step<A> = Result.Result<A, Arr.NonEmptyReadonlyArray<Finding>>

export const refuse = (reason: Reason, line: number, detail: string): Step<never> =>
	Result.fail([{ code: reason, line, detail }])

/** Every step's value, or every refusal of the steps that refused. */
export const gathered = <A>(steps: ReadonlyArray<Step<A>>): Step<ReadonlyArray<A>> => {
	const refusals = Arr.flatMap(steps, (step) => (Result.isFailure(step) ? step.failure : []))
	return Arr.isReadonlyArrayNonEmpty(refusals)
		? Result.fail(refusals)
		: Result.succeed(Arr.flatMap(steps, (step) => (Result.isSuccess(step) ? [step.success] : [])))
}

/** What a local name of a module is: a module's export, `default` or `*` for a default or namespace import. */
export type Binding = Readonly<{ module: string; name: string }>

/** A module's imports, by the local name each binds. */
export const importsOf = (parsed: Parsed): ReadonlyMap<string, Binding> =>
	new Map(
		Arr.flatMap(parsed.tree.statements, (statement): ReadonlyArray<readonly [string, Binding]> => {
			if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) {
				return []
			}
			const module = Option.getOrElse(stringValueOf(statement.moduleSpecifier), () => "")
			const clause = statement.importClause
			const named = clause.namedBindings
			return [
				...(clause.name === undefined
					? []
					: [[clause.name.text, { module, name: "default" }] as const]),
				...(named === undefined
					? []
					: ts.isNamespaceImport(named)
						? [[named.name.text, { module, name: "*" }] as const]
						: Arr.map(
								named.elements,
								(e) =>
									[
										e.name.text,
										{ module, name: (e.propertyName ?? e.name).getText(parsed.tree) }
									] as const
							))
			]
		})
	)

/** Whether an expression is the local name of `name` imported from `module`. */
export const isImported = (
	imports: ReadonlyMap<string, Binding>,
	expression: ts.Expression,
	modules: ReadonlyArray<string>,
	name: string
): boolean => {
	const bare = unparenthesized(expression)
	if (!ts.isIdentifier(bare)) {
		return false
	}
	const binding = imports.get(bare.text)
	return binding !== undefined && Arr.contains(modules, binding.module) && binding.name === name
}

/** Whether an expression is a local name Vitest exports as `name`, from either Vitest module. */
const isVitest = (
	imports: ReadonlyMap<string, Binding>,
	expression: ts.Expression,
	name: string
): boolean => isImported(imports, expression, ["@effect/vitest", "vitest"], name)

/**
 * Where a test is registered: the names of the describes and layers above it, outermost first; the layers that provide
 * its services, outermost first; whether it.effect there runs under the test services (TestClock, TestConsole); and the
 * name the registering `it` is bound to there.
 */
export type Frame = Readonly<{
	names: ReadonlyArray<string>
	layers: ReadonlyArray<ts.Expression>
	testServices: boolean
	it: string
}>

/** A test: its frame, its own name, its registering call and whether it runs live (it.live). */
export type Test = Readonly<{
	frame: Frame
	name: string
	call: ts.CallExpression
	live: boolean
}>

/**
 * A module's statements as the conversion reads them, in source order: a module declaration it keeps where it is, a
 * describe's declaration it lifts to module scope, the comments above a registration, and a test.
 */
export type Piece =
	| Readonly<{ kind: "declaration"; statement: ts.Statement }>
	| Readonly<{ kind: "comments"; text: string }>
	| Readonly<{ kind: "test"; test: Test }>

type Walk = Readonly<{
	parsed: Parsed
	plugin: Plugin
	imports: ReadonlyMap<string, Binding>
}>

const shapeOf = (walk: Walk, node: ts.Node, detail: string): Step<never> =>
	refuse("registration-shape", lineOf(walk.parsed, node), detail)

/** The callback a describe or a layer registers its block with, and the name its parameter binds, if any. */
const blockOf = (
	walk: Walk,
	callback: ts.Expression | undefined,
	at: ts.Node
): Step<
	Readonly<{ statements: ReadonlyArray<ts.Statement>; parameter: Option.Option<string> }>
> => {
	const bare = callback === undefined ? undefined : unparenthesized(callback)
	if (
		bare === undefined ||
		!(ts.isArrowFunction(bare) || ts.isFunctionExpression(bare)) ||
		!ts.isBlock(bare.body) ||
		bare.parameters.length > 1
	) {
		return shapeOf(walk, at, "a registration callback that is not a block of zero or one parameter")
	}
	const parameter = bare.parameters[0]
	if (parameter !== undefined && !ts.isIdentifier(parameter.name)) {
		return shapeOf(walk, at, "a layer callback whose parameter is a pattern")
	}
	return Result.succeed({
		statements: bare.body.statements,
		parameter:
			parameter !== undefined && ts.isIdentifier(parameter.name)
				? Option.some(parameter.name.text)
				: Option.none()
	})
}

/** The options a layer registration may state that the codemod reads; any other is a shape it leaves. */
const LAYER_OPTIONS: ReadonlyArray<string> = ["excludeTestServices", "timeout"]

/** Whether a layer's options exclude the test services, or a refusal of options the codemod does not read. */
const testServicesOf = (walk: Walk, options: ts.Expression | undefined): Step<boolean> => {
	if (options === undefined) {
		return Result.succeed(true)
	}
	const bare = unparenthesized(options)
	if (!ts.isObjectLiteralExpression(bare)) {
		return shapeOf(walk, options, "layer options that are not an object literal")
	}
	const named = Arr.map(bare.properties, (p) =>
		ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)
			? Option.some([p.name.text, p.initializer] as const)
			: Option.none()
	)
	const fields = Arr.getSomes(named)
	if (
		fields.length !== named.length ||
		!Arr.every(fields, ([name]) => Arr.contains(LAYER_OPTIONS, name))
	) {
		return shapeOf(walk, options, `layer options ${textOf(options)}`)
	}
	return Result.succeed(
		!Arr.some(
			fields,
			([name, value]) => name === "excludeTestServices" && value.kind === ts.SyntaxKind.TrueKeyword
		)
	)
}

/**
 * A registration's name: a string literal's text, or a template's as written between its backticks (its substitutions
 * kept as `${...}`, so the export's JSDoc reads as the test's title did); anything else is a refusal.
 */
const nameOf = (walk: Walk, name: ts.Expression | undefined, at: ts.Node): Step<string> => {
	if (name === undefined) {
		return shapeOf(walk, at, "a registration without a name")
	}
	const bare = unparenthesized(name)
	return Option.match(stringValueOf(bare), {
		onNone: () =>
			ts.isTemplateExpression(bare)
				? Result.succeed(Str.slice(1, -1)(textOf(bare)))
				: shapeOf(walk, name, `a computed name ${textOf(name)}`),
		onSome: Result.succeed
	})
}

/** A block's statements: declarations lifted to module scope, registrations read, anything else refused. */
const blockPieces = (
	walk: Walk,
	frame: Frame,
	statements: ReadonlyArray<ts.Statement>
): Step<ReadonlyArray<Piece>> =>
	Result.map(
		gathered(
			Arr.map(statements, (statement): Step<ReadonlyArray<Piece>> =>
				isDeclaration(statement)
					? Result.succeed([{ kind: "declaration", statement }])
					: registration(walk, frame, statement, "registration-statement")
			)
		),
		Arr.flatten
	)

/**
 * The pieces of one registration statement: an it.effect or it.live, a describe, or a layer (`layer(L, options)(name,
 * (it) => ...)` or `it.layer(L)(name, (it) => ...)`), its leading comments kept above them.
 */
const registration = (
	walk: Walk,
	frame: Frame,
	statement: ts.Statement,
	otherwise: Reason
): Step<ReadonlyArray<Piece>> => {
	const { parsed, imports } = walk
	const other = refuse(otherwise, lineOf(parsed, statement), Str.slice(0, 80)(textOf(statement)))
	if (!ts.isExpressionStatement(statement)) {
		return other
	}
	const call = unparenthesized(statement.expression)
	if (!ts.isCallExpression(call)) {
		return other
	}
	const comments = Option.match(
		Option.liftPredicate(
			Str.trim(Str.slice(statement.pos, statement.getStart(parsed.tree))(parsed.text)),
			(text) => text.length > 0
		),
		{
			onNone: (): ReadonlyArray<Piece> => [],
			onSome: (text): ReadonlyArray<Piece> => [{ kind: "comments", text }]
		}
	)
	const withComments = (pieces: Step<ReadonlyArray<Piece>>) =>
		Result.map(pieces, (ps) => [...comments, ...ps])
	const callee = unparenthesized(call.expression)
	if (
		ts.isPropertyAccessExpression(callee) &&
		ts.isIdentifier(callee.expression) &&
		callee.expression.text === frame.it
	) {
		const method = callee.name.text
		if (method !== "effect" && method !== "live" && method !== "layer") {
			return shapeOf(walk, call, `${frame.it}.${method}`)
		}
		if (method === "layer") {
			return shapeOf(walk, call, `${frame.it}.layer called without its registration`)
		}
		return withComments(
			Result.map(nameOf(walk, call.arguments[0], call), (name) => [
				{ kind: "test", test: { frame, name, call, live: method === "live" } }
			])
		)
	}
	if (isVitest(imports, callee, "describe")) {
		return withComments(
			Result.flatMap(nameOf(walk, call.arguments[0], call), (name) =>
				Result.flatMap(blockOf(walk, call.arguments[1], call), ({ statements, parameter }) =>
					Option.isSome(parameter)
						? shapeOf(walk, call, "a describe callback with a parameter")
						: blockPieces(walk, { ...frame, names: [...frame.names, name] }, statements)
				)
			)
		)
	}
	if (ts.isCallExpression(callee)) {
		const layerCallee = unparenthesized(callee.expression)
		const isLayer =
			isVitest(imports, layerCallee, "layer") ||
			(ts.isPropertyAccessExpression(layerCallee) &&
				ts.isIdentifier(layerCallee.expression) &&
				layerCallee.expression.text === frame.it &&
				layerCallee.name.text === "layer")
		const provided = callee.arguments[0]
		if (!isLayer || provided === undefined || callee.arguments.length > 2) {
			return other
		}
		const named = call.arguments.length === 2
		return withComments(
			Result.flatMap(testServicesOf(walk, callee.arguments[1]), (testServices) =>
				Result.flatMap(named ? nameOf(walk, call.arguments[0], call) : Result.succeed(""), (name) =>
					Result.flatMap(
						blockOf(walk, named ? call.arguments[1] : call.arguments[0], call),
						({ statements, parameter }) =>
							blockPieces(
								walk,
								{
									names: named ? [...frame.names, name] : frame.names,
									layers: [...frame.layers, provided],
									testServices,
									it: Option.getOrElse(parameter, () => frame.it)
								},
								statements
							)
					)
				)
			)
		)
	}
	return refuse(otherwise, lineOf(parsed, statement), calleeOf(call))
}

/** A module's top level as pieces: its imports aside, every statement a declaration or a registration. */
export const piecesOf = (
	parsed: Parsed,
	plugin: Plugin,
	imports: ReadonlyMap<string, Binding>
): Step<ReadonlyArray<Piece>> => {
	const it = Option.getOrElse(
		Arr.findFirst(
			[...imports.entries()],
			([, binding]) =>
				(binding.module === "@effect/vitest" || binding.module === "vitest") &&
				binding.name === "it"
		).pipe(Option.map(([local]) => local)),
		() => "it"
	)
	const frame: Frame = { names: [], layers: [], testServices: true, it }
	const walk: Walk = { parsed, plugin, imports }
	return Result.map(
		gathered(
			Arr.map(
				Arr.filter(parsed.tree.statements, (s) => !ts.isImportDeclaration(s)),
				(statement): Step<ReadonlyArray<Piece>> =>
					isDeclaration(statement) ||
					ts.isInterfaceDeclaration(statement) ||
					ts.isTypeAliasDeclaration(statement)
						? Result.succeed([{ kind: "declaration", statement }])
						: registration(walk, frame, statement, "module-statement")
			)
		),
		Arr.flatten
	)
}
