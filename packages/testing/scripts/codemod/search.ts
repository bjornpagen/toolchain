import { regex } from "arkregex"
import { Array as Arr, Option, Record as Rec, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Plugin, Provision, Wanted } from "#codemod/plugin.ts"
import {
	type Api,
	type Binding,
	gathered,
	isImported,
	OLD,
	refuse,
	type Step,
	type Test
} from "#codemod/registrations.ts"
import type { Finding } from "#codemod/report.ts"
import {
	boundNamesOf,
	calleeOf,
	declaredNamesOf,
	holds,
	identifiersUnder,
	isDeclaration,
	lineOf,
	namesUnder,
	type Parsed,
	textOf,
	unparenthesized,
	withCommentsOf
} from "#codemod/syntax.ts"

/** The new API's names a converted module reads, each under the local name the module leaves free for it. */
export type Locals = Readonly<{
	property: string
	Case: string
	Reached: string
	finite: string
	aimed: string
}>

/**
 * A module under conversion: its parse, its plugin, its imports, its constants by name, where it imports the new API
 * from and under which local names.
 */
export type Module = Readonly<{
	parsed: Parsed
	plugin: Plugin
	imports: ReadonlyMap<string, Binding>
	constants: ReadonlyMap<string, ts.Expression>
	api: Api
	locals: Locals
}>

/** A converted test: its export's name and text, the setup lifted to module scope above it, its imports and notes. */
export type Built = Readonly<{
	name: string
	lifted: ReadonlyArray<ts.Statement>
	text: string
	wanted: ReadonlyArray<Wanted>
	notes: ReadonlyArray<Finding>
}>

/** The two searches, by the constructor each becomes. */
type Kind = "explore" | "exhaust"

/** A search's fields each search admits, its own and those now runner Limits. */
const FIELDS: Readonly<Record<Kind, ReadonlyArray<string>>> = {
	explore: [
		"suite",
		"draw",
		"literal",
		"coverage",
		"kept",
		"runs",
		"shrink",
		"concurrency",
		"steerEvery",
		"caseHang",
		"oracle"
	],
	exhaust: ["suite", "generator", "literal", "coverage", "caseHang", "box", "oracle", "concurrency"]
}

/**
 * What a search runs inside, outermost first: the statements of an Effect.gen before its last `return yield*`, or the
 * stages piped around an effect (`.pipe(...)`, `Effect.scoped(...)`).
 */
type Wrapper =
	| Readonly<{ kind: "setup"; statements: ReadonlyArray<ts.Statement> }>
	| Readonly<{ kind: "stages"; stages: ReadonlyArray<ts.Expression> }>

/** The search a test runs, and what it runs inside, outermost first. */
type Search = Readonly<{
	kind: Kind
	call: ts.CallExpression
	wrappers: ReadonlyArray<Wrapper>
}>

/** Every setup statement of a search's wrappers, in the order they run. */
const setupOf = (wrappers: ReadonlyArray<Wrapper>): ReadonlyArray<ts.Statement> =>
	Arr.flatMap(wrappers, (w) => (w.kind === "setup" ? w.statements : []))

/** Every stage of a search's wrappers. */
const stagesOf = (wrappers: ReadonlyArray<Wrapper>): ReadonlyArray<ts.Expression> =>
	Arr.flatMap(wrappers, (w) => (w.kind === "stages" ? w.stages : []))

/** What a draw becomes: the space's text, the sketch's resolve when the check must call it, and the imports. */
type Space = Readonly<{
	text: string
	reads: ReadonlyArray<string>
	resolve: Option.Option<string>
	wanted: ReadonlyArray<Wanted>
}>

/** What a coverage becomes: the situations' text, the names it reads, and the vocabulary its type argument stated. */
type Situations = Readonly<{
	text: string
	reads: ReadonlyArray<string>
	vocabulary: Option.Option<string>
}>

const lineAt = (module: Module, node: ts.Node) => lineOf(module.parsed, node)

/** A name not in `used`: `base`, or `base` numbered from 2. */
export const freshName = (base: string, used: ReadonlySet<string>): string => {
	const go = (n: number): string => {
		const name = n === 1 ? base : `${base}${n}`
		return used.has(name) ? go(n + 1) : name
	}
	return go(1)
}

/**
 * An expression, or the initializer of the module constant it names, followed to its definition, through `as const`,
 * `satisfies` and Object.freeze, which change nothing a field reads.
 */
const definitionOf = (module: Module, expression: ts.Expression): ts.Expression => {
	const bare = unparenthesized(expression)
	if (ts.isAsExpression(bare) || ts.isSatisfiesExpression(bare)) {
		return definitionOf(module, bare.expression)
	}
	if (
		ts.isCallExpression(bare) &&
		calleeOf(module.parsed, bare) === "Object.freeze" &&
		bare.arguments.length === 1 &&
		bare.arguments[0] !== undefined
	) {
		return definitionOf(module, bare.arguments[0])
	}
	const constant = ts.isIdentifier(bare) ? module.constants.get(bare.text) : undefined
	return constant === undefined ? bare : definitionOf(module, constant)
}

/**
 * An effect read as layers around a core: the statements of each Effect.gen before its last `return yield* <core>`,
 * outermost first, and the stages piped around them (`.pipe(...)`, `Effect.scoped(...)`), innermost first; or a
 * refusal of a generator that returns before its last statement.
 */
type Peeled = Readonly<{ core: ts.Expression; wrappers: ReadonlyArray<Wrapper> }>

const peeled = (module: Module, expression: ts.Expression, around: Peeled): Step<Peeled> => {
	const { parsed } = module
	const bare = unparenthesized(expression)
	if (!ts.isCallExpression(bare)) {
		return Result.succeed({ ...around, core: bare })
	}
	const callee = unparenthesized(bare.expression)
	if (ts.isPropertyAccessExpression(callee) && callee.name.text === "pipe") {
		return peeled(module, callee.expression, {
			...around,
			wrappers: [...around.wrappers, { kind: "stages", stages: bare.arguments }]
		})
	}
	const first = bare.arguments[0]
	const name = calleeOf(parsed, bare)
	if (name === "Effect.suspend" && first !== undefined && bare.arguments.length === 1) {
		const thunk = unparenthesized(first)
		return ts.isArrowFunction(thunk) && thunk.parameters.length === 0
			? peeledBody(module, thunk.body, around)
			: Result.succeed({ ...around, core: bare })
	}
	if (name === "Effect.scoped" && first !== undefined && bare.arguments.length === 1) {
		return peeled(module, first, {
			...around,
			wrappers: [...around.wrappers, { kind: "stages", stages: [bare.expression] }]
		})
	}
	if (name !== "Effect.gen" || first === undefined || bare.arguments.length !== 1) {
		return Result.succeed({ ...around, core: bare })
	}
	const fn = unparenthesized(first)
	if (!ts.isFunctionExpression(fn) || fn.asteriskToken === undefined || fn.parameters.length > 0) {
		return refuse("setup-shape", lineOf(parsed, bare), "Effect.gen of no generator function")
	}
	const statements = fn.body.statements
	const returned = Option.flatMap(Arr.last(statements), (statement) => {
		const value = ts.isReturnStatement(statement) ? statement.expression : undefined
		const yielded = value === undefined ? undefined : unparenthesized(value)
		return yielded !== undefined &&
			ts.isYieldExpression(yielded) &&
			yielded.asteriskToken !== undefined &&
			yielded.expression !== undefined
			? Option.some(yielded.expression)
			: Option.none()
	})
	if (Option.isNone(returned)) {
		return Arr.some(statements, (statement) => holdsSearch(module, statement))
			? refuse(
					"after-search",
					lineOf(parsed, bare),
					"statements after the search read its cases together"
				)
			: refuse("setup-shape", lineOf(parsed, bare), "its last statement is not `return yield* ...`")
	}
	const setup = Arr.dropRight(statements, 1)
	if (Arr.some(setup, returnsOf)) {
		return refuse("setup-shape", lineOf(parsed, bare), "the setup returns before its search")
	}
	return peeled(module, returned.value, {
		...around,
		wrappers: [...around.wrappers, { kind: "setup", statements: setup }]
	})
}

/**
 * Whether a stage piped around a search provides what its setup and property run under (a scope, a layer, a service),
 * which the check keeps, rather than reading the search's result, which the runner owns now.
 */
const isProvision = (module: Module, stage: ts.Expression): boolean => {
	const bare = unparenthesized(stage)
	const name = ts.isCallExpression(bare)
		? calleeOf(module.parsed, bare)
		: textOf(module.parsed, bare)
	return (
		name === "Effect.scoped" ||
		Str.startsWith("Effect.provide")(name) ||
		Arr.contains(module.plugin.stages, name)
	)
}

/** Whether a statement runs a search: an explore or exhaust call anywhere in it. */
const holdsSearch = (module: Module, statement: ts.Node): boolean => {
	const visit = (node: ts.Node): boolean | undefined =>
		ts.isCallExpression(node) && Option.isSome(kindOf(module, node))
			? true
			: node.forEachChild(visit)
	return visit(statement) === true
}

/**
 * A function body read as layers: an expression is peeled as it is; a block whose last statement returns an effect is
 * setup (its statements before, run when the effect is built) around the effect it returns.
 */
const peeledBody = (module: Module, body: ts.ConciseBody, around: Peeled): Step<Peeled> => {
	if (!ts.isBlock(body)) {
		return peeled(module, body, around)
	}
	const last = Arr.last(body.statements)
	const returned = Option.flatMap(last, (statement) =>
		ts.isReturnStatement(statement) && statement.expression !== undefined
			? Option.some(statement.expression)
			: Option.none()
	)
	const setup = Arr.dropRight(body.statements, 1)
	if (Option.isNone(returned) || Arr.some(setup, returnsOf)) {
		return refuse(
			"setup-shape",
			lineOf(module.parsed, body),
			"a block that does not end in returning its effect"
		)
	}
	return peeled(module, returned.value, {
		...around,
		wrappers: [...around.wrappers, { kind: "setup", statements: setup }]
	})
}

/** The search kind a call starts, if it calls explore or exhaust. */
const kindOf = (module: Module, expression: ts.Expression): Option.Option<Kind> =>
	ts.isCallExpression(expression)
		? isImported(module.imports, expression.expression, OLD.explore, "explore")
			? Option.some("explore")
			: isImported(module.imports, expression.expression, OLD.explore, "exhaust")
				? Option.some("exhaust")
				: Option.none()
		: Option.none()

/**
 * The search a test runs, with the setup around it: its body is `searched(ctx, effect)` (or an Effect.gen whose last
 * statement returns one), and the effect is a search, or an Effect.gen whose last statement returns one; the setup of
 * both is read in order, and the stages piped around both are kept.
 */
const searchOf = (module: Module, test: Test, ctx: Option.Option<string>): Step<Search> => {
	const { parsed, plugin, imports } = module
	const callback =
		test.call.arguments[1] === undefined ? undefined : unparenthesized(test.call.arguments[1])
	if (callback === undefined || !ts.isArrowFunction(callback) || callback.parameters.length > 1) {
		return refuse("test-shape", lineOf(parsed, test.call), test.name)
	}
	const written = callback.body
	const body: ts.ConciseBody = ts.isBlock(written)
		? written
		: Option.getOrElse(plugin.unwrap(parsed, written), () => written)
	return Result.flatMap(peeledBody(module, body, { core: test.call, wrappers: [] }), (outer) => {
		const searched = outer.core
		if (
			!ts.isCallExpression(searched) ||
			!isImported(imports, searched.expression, OLD.searched, "searched") ||
			searched.arguments.length !== 2
		) {
			return refuse(
				Str.includes("searched(")(textOf(parsed, body)) ? "test-shape" : "not-searched",
				lineOf(parsed, test.call),
				test.name
			)
		}
		const [given, inner] = searched.arguments
		if (inner === undefined || given === undefined) {
			return refuse("test-shape", lineOf(parsed, test.call), test.name)
		}
		const reads = [
			...identifiersUnder(inner),
			...Arr.flatMap(setupOf(outer.wrappers), identifiersUnder),
			...Arr.flatMap(stagesOf(outer.wrappers), identifiersUnder)
		]
		const passesCtx = Option.match(ctx, {
			onNone: () => false,
			onSome: (name) => ts.isIdentifier(given) && given.text === name
		})
		if (!passesCtx || Option.exists(ctx, (name) => Arr.contains(reads, name))) {
			return refuse("test-context", lineOf(parsed, searched), test.name)
		}
		if (Arr.contains(reads, "TestClock")) {
			return refuse("test-clock", lineOf(parsed, searched), test.name)
		}
		return Result.flatMap(peeled(module, inner, { ...outer, core: inner }), (whole) =>
			Option.match(kindOf(module, whole.core), {
				onNone: () =>
					refuse(
						ts.isCallExpression(whole.core) ? "search-helper" : "setup-shape",
						lineOf(parsed, whole.core),
						ts.isCallExpression(whole.core)
							? calleeOf(parsed, whole.core)
							: Str.slice(0, 60)(textOf(parsed, whole.core))
					),
				onSome: (kind) => {
					const foreign = Arr.filter(
						stagesOf(whole.wrappers),
						(stage) => !isProvision(module, stage)
					)
					return Arr.isReadonlyArrayNonEmpty(foreign)
						? refuse(
								"setup-shape",
								lineOf(parsed, foreign[0]),
								`a stage on the search's result: ${Str.slice(0, 60)(textOf(parsed, foreign[0]))}`
							)
						: ts.isCallExpression(whole.core)
							? Result.succeed({ kind, call: whole.core, wrappers: whole.wrappers })
							: refuse("setup-shape", lineOf(parsed, whole.core), test.name)
				}
			})
		)
	})
}

/** Whether a statement returns from the function it is in: a return outside any nested function. */
const returnsOf = (statement: ts.Node): boolean => {
	const visit = (node: ts.Node): boolean | undefined =>
		ts.isReturnStatement(node)
			? true
			: ts.isFunctionLikeDeclaration(node) ||
				  ts.isArrowFunction(node) ||
				  ts.isClassLikeDeclaration(node)
				? undefined
				: node.forEachChild(visit)
	return visit(statement) === true
}

/** A spec's fields by name: an object literal's, or a plugin builder's argument's. */
const fieldsOf = (
	module: Module,
	kind: Kind,
	spec: ts.Expression
): Step<ReadonlyMap<string, ts.Expression>> => {
	const bare = definitionOf(module, spec)
	if (
		ts.isCallExpression(bare) &&
		bare.arguments.length === 1 &&
		Arr.some(module.plugin.builders, (b) =>
			isImported(module.imports, bare.expression, [b.module], b.name)
		)
	) {
		const argument = bare.arguments[0]
		return argument === undefined
			? refuse("spec-shape", lineAt(module, bare), "a builder with no argument")
			: fieldsOf(module, kind, argument)
	}
	if (!ts.isObjectLiteralExpression(bare)) {
		return refuse("spec-shape", lineAt(module, bare), Str.slice(0, 60)(textOf(module.parsed, bare)))
	}
	const fields = Arr.map(
		bare.properties,
		(p): Step<ReadonlyArray<readonly [string, ts.Expression]>> => {
			if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
				return Result.succeed([[p.name.text, p.initializer]])
			}
			if (ts.isShorthandPropertyAssignment(p) && ts.isIdentifier(p.name)) {
				return Result.succeed([[p.name.text, p.name]])
			}
			if (ts.isSpreadAssignment(p)) {
				return Result.map(fieldsOf(module, kind, p.expression), (spread) => [...spread.entries()])
			}
			return refuse("spec-shape", lineAt(module, p), Str.slice(0, 60)(textOf(module.parsed, p)))
		}
	)
	return Result.flatMap(Result.map(gathered(fields), Arr.flatten), (entries) => {
		const unknown = Arr.filter(entries, ([name]) => !Arr.contains(FIELDS[kind], name))
		return Arr.isReadonlyArrayNonEmpty(unknown)
			? refuse(
					"spec-shape",
					lineAt(module, bare),
					`fields ${Arr.join(
						Arr.map(unknown, ([n]) => n),
						", "
					)}`
				)
			: Result.succeed(new Map(entries))
	})
}

/** A field a search must state, or a refusal naming it. */
const required = (
	module: Module,
	fields: ReadonlyMap<string, ts.Expression>,
	name: string,
	at: ts.Node
): Step<ts.Expression> => {
	const value = fields.get(name)
	return value === undefined
		? refuse("spec-shape", lineAt(module, at), `no ${name}`)
		: Result.succeed(value)
}

/** What an exploration's draw becomes: drawn(g) is g, aimed(g, aims) stays aimed, sketched(g, resolve) is g resolved. */
const spaceOfDraw = (module: Module, draw: ts.Expression): Step<Space> => {
	const bare = definitionOf(module, draw)
	const refused = refuse(
		"draw-shape",
		lineAt(module, bare),
		Str.slice(0, 60)(textOf(module.parsed, bare))
	)
	if (!ts.isCallExpression(bare)) {
		return refused
	}
	const [generator, second] = bare.arguments
	const is = (name: string) => isImported(module.imports, bare.expression, OLD.explore, name)
	if (generator === undefined) {
		return refused
	}
	const text = textOf(module.parsed, generator)
	const reads = identifiersUnder(bare)
	if (is("drawn") && bare.arguments.length === 1) {
		return Result.succeed({ text, reads, resolve: Option.none(), wanted: [] })
	}
	if (is("aimed") && second !== undefined && bare.arguments.length === 2) {
		return Result.succeed({
			text: `${module.locals.aimed}(${text}, ${textOf(module.parsed, second)})`,
			reads,
			resolve: Option.none(),
			wanted: [{ module: module.api.gen, name: "aimed", local: module.locals.aimed, type: false }]
		})
	}
	if (is("sketched") && second !== undefined && bare.arguments.length === 2) {
		return Result.succeed({
			text,
			reads: identifiersUnder(generator),
			resolve: Option.some(textOf(module.parsed, second)),
			wanted: []
		})
	}
	return refused
}

/**
 * A steered phase's sense, which the runner's steering replaces: notesOnly, or a refusal of another (V8's block coverage
 * becomes a guide whose blocks are the files its predicate covers, which only a person can name).
 */
const senseOf = (module: Module, steered: ts.Expression | undefined): Step<void> => {
	if (steered === undefined) {
		return Result.void
	}
	const phase = definitionOf(module, steered)
	const sense = ts.isObjectLiteralExpression(phase)
		? Arr.findFirst(
				phase.properties,
				(p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "sense"
			)
		: Option.none()
	const value = Option.flatMap(sense, (p) =>
		ts.isPropertyAssignment(p) ? Option.some(definitionOf(module, p.initializer)) : Option.none()
	)
	if (Option.isNone(value)) {
		return refuse(
			"coverage-shape",
			lineAt(module, phase),
			`a steered phase ${Str.slice(0, 60)(textOf(module.parsed, phase))}`
		)
	}
	if (isImported(module.imports, value.value, OLD.sense, "notesOnly")) {
		return Result.void
	}
	return refuse(
		"coverage-shape",
		lineAt(module, value.value),
		`a sense ${Str.slice(0, 60)(textOf(module.parsed, value.value))}`
	)
}

/** What a coverage becomes: required's and requiredInSpace's list with its type argument; none's empty list. */
const situationsOf = (module: Module, coverage: ts.Expression): Step<Situations> => {
	const bare = definitionOf(module, coverage)
	const refused = refuse(
		"coverage-shape",
		lineAt(module, bare),
		Str.slice(0, 60)(textOf(module.parsed, bare))
	)
	const none = Result.succeed({
		text: "[]",
		reads: [],
		vocabulary: Option.none()
	})
	if (isImported(module.imports, bare, OLD.features, "noCoverage")) {
		return none
	}
	if (ts.isObjectLiteralExpression(bare)) {
		return Str.replaceAll(WHITESPACE, "")(textOf(module.parsed, bare)) === '{kind:"none"}'
			? none
			: refused
	}
	if (
		!ts.isCallExpression(bare) ||
		!(
			isImported(module.imports, bare.expression, OLD.features, "required") ||
			isImported(module.imports, bare.expression, OLD.features, "requiredInSpace")
		)
	) {
		return refused
	}
	const [list, steered] = bare.arguments
	const vocabulary = bare.typeArguments?.[0]
	if (list === undefined) {
		return refused
	}
	return Result.map(senseOf(module, steered), () => ({
		text: textOf(module.parsed, list),
		reads: [
			...identifiersUnder(list),
			...(vocabulary === undefined ? [] : identifiersUnder(vocabulary))
		],
		vocabulary:
			vocabulary === undefined ? Option.none() : Option.some(textOf(module.parsed, vocabulary))
	}))
}

/** A property callback's parameters and body, or the callback itself when it is not a function literal. */
type Callback =
	| Readonly<{
			kind: "literal"
			value: Option.Option<ts.ParameterDeclaration>
			c: Option.Option<ts.ParameterDeclaration>
			body: ts.ConciseBody
	  }>
	| Readonly<{ kind: "reference"; expression: ts.Expression }>

const callbackOf = (module: Module, property: ts.Expression): Step<Callback> => {
	const bare = unparenthesized(property)
	if (!ts.isArrowFunction(bare) && !ts.isFunctionExpression(bare)) {
		return Result.succeed({ kind: "reference", expression: bare })
	}
	const body = bare.body
	if (
		bare.parameters.length > 2 ||
		bare.typeParameters !== undefined ||
		(ts.isFunctionExpression(bare) && bare.asteriskToken !== undefined) ||
		Arr.some(bare.modifiers ?? [], (m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
		Arr.some(
			bare.parameters,
			(p) => p.initializer !== undefined || p.dotDotDotToken !== undefined
		) ||
		holds(body, ts.SyntaxKind.ThisKeyword)
	) {
		return refuse(
			"property-shape",
			lineAt(module, bare),
			Str.slice(0, 60)(textOf(module.parsed, bare))
		)
	}
	return Result.succeed({
		kind: "literal",
		value: Option.fromNullishOr(bare.parameters[0]),
		c: Option.fromNullishOr(bare.parameters[1]),
		body
	})
}

/** Whitespace, anywhere. */
const WHITESPACE = regex("\\s", "g")

/** A sentence's last character. */
const SENTENCE_END = regex("[.!?]$")

/** An apostrophe, straight or curly, anywhere. */
const APOSTROPHE = regex("['’]", "g")

/** What separates the words of a name. */
const WORD_BREAK = regex("[^\\p{L}\\p{N}]+", "u")

/** A name that starts with a digit, which no identifier may. */
const LEADING_DIGIT = regex("^\\p{N}", "u")

/** What reads the clock or the console, which it.effect's test services replaced. */
const CLOCKED = regex("\\b(Clock\\.|DateTime\\.now|Effect\\.sleep|TestConsole|Console\\.)")

/** The JSDoc an export carries: the describes' and the test's names, read as one sentence. */
const sentenceOf = (test: Test): string => {
	const joined = Str.replaceAll("*/", "*\\/")(Arr.join([...test.frame.names, test.name], " "))
	const capital = Str.capitalize(joined)
	return SENTENCE_END.test(capital) ? capital : `${capital}.`
}

/** The words JavaScript reserves, which no export may be named. */
const RESERVED: ReadonlySet<string> = new Set([
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield"
])

/** The camelCase name of the describes' and the test's names, a valid identifier. */
const camelOf = (test: Test): string => {
	const words = Arr.filter(
		Str.split(
			Str.replaceAll(APOSTROPHE, "")(Arr.join([...test.frame.names, test.name], " ")),
			WORD_BREAK
		),
		Str.isNonEmpty
	)
	const joined = Arr.join(
		Arr.map(words, (word, i) => (i === 0 ? Str.uncapitalize(word) : Str.capitalize(word))),
		""
	)
	const named =
		joined.length === 0 ? "property" : LEADING_DIGIT.test(joined) ? `property${joined}` : joined
	return RESERVED.has(named) ? `${named}Property` : named
}

/** A layer's parts: a merge's layers, each read on its own when the plugin does not map the merge whole. */
const layerPartsOf = (module: Module, layer: ts.Expression): ReadonlyArray<ts.Expression> => {
	const bare = unparenthesized(layer)
	if (Option.isSome(module.plugin.provision(textOf(module.parsed, bare)))) {
		return [bare]
	}
	const callee = ts.isCallExpression(bare) ? calleeOf(module.parsed, bare) : ""
	return ts.isCallExpression(bare) && (callee === "Layer.merge" || callee === "Layer.mergeAll")
		? Arr.flatMap(bare.arguments, (a) => layerPartsOf(module, a))
		: [bare]
}

/** How a test's layers provide its check's services, outermost first, or a refusal of each layer no plugin maps. */
const provisionsOf = (module: Module, test: Test): Step<ReadonlyArray<Provision>> =>
	gathered(
		Arr.map(
			Arr.flatMap(test.frame.layers, (layer) => layerPartsOf(module, layer)),
			(part): Step<Provision> =>
				Option.match(module.plugin.provision(textOf(module.parsed, part)), {
					onNone: () => refuse("layer", lineAt(module, part), textOf(module.parsed, part)),
					onSome: Result.succeed
				})
		)
	)

/** A box an exhaustion states: its text, or a refusal of an unstated one. */
const boxOf = (
	module: Module,
	fields: ReadonlyMap<string, ts.Expression>,
	at: ts.Node
): Step<Readonly<{ text: string; reads: ReadonlyArray<string> }>> =>
	Result.flatMap(required(module, fields, "box", at), (box) => {
		const bare = definitionOf(module, box)
		return ts.isObjectLiteralExpression(bare)
			? refuse("box-unstated", lineAt(module, bare), textOf(module.parsed, bare))
			: Result.succeed({ text: textOf(module.parsed, box), reads: identifiersUnder(box) })
	})

/** Kept cases by value: none, or a refusal, since a kept case is a token only once it has run. */
const keptOf = (module: Module, fields: ReadonlyMap<string, ts.Expression>): Step<void> => {
	const kept = fields.get("kept")
	if (kept === undefined) {
		return Result.void
	}
	const bare = definitionOf(module, kept)
	return ts.isArrayLiteralExpression(bare) && bare.elements.length === 0
		? Result.void
		: refuse("kept-by-value", lineAt(module, bare), Str.slice(0, 60)(textOf(module.parsed, bare)))
}

/** Whether a space is a case list: element over a list, which no property's space may be. */
const caseListOf = (module: Module, generator: ts.Expression): Step<void> => {
	const bare = definitionOf(module, generator)
	return ts.isCallExpression(bare) &&
		isImported(module.imports, bare.expression, OLD.gen, "element")
		? refuse("space-case-list", lineAt(module, bare), Str.slice(0, 60)(textOf(module.parsed, bare)))
		: Result.void
}

/**
 * Whether a value is one a module must not hold: an array, an object or a regular expression literal, which a property
 * could write or advance; one frozen (`as const`, Object.freeze) is a value.
 */
const isMutable = (initializer: ts.Expression | undefined): boolean => {
	if (initializer === undefined) {
		return false
	}
	const bare = unparenthesized(initializer)
	if (ts.isAsExpression(bare) && textOfType(bare) === "const") {
		return false
	}
	return (
		ts.isArrayLiteralExpression(bare) ||
		ts.isObjectLiteralExpression(bare) ||
		ts.isRegularExpressionLiteral(bare)
	)
}

/** An `as` expression's type as written. */
const textOfType = (expression: ts.AsExpression): string =>
	expression.type.kind === ts.SyntaxKind.TypeReference &&
	ts.isTypeReferenceNode(expression.type) &&
	ts.isIdentifier(expression.type.typeName)
		? expression.type.typeName.text
		: ""

/** The setup split: what moves to module scope (pure values), and what each case runs before its check (the rest). */
type Split = Readonly<{
	lifted: ReadonlyArray<ts.Statement>
	prefix: ReadonlyArray<ts.Statement>
	perCase: ReadonlySet<string>
}>

/**
 * Splits a setup: a const or function whose value reads nothing the setup builds per case, yields nothing, awaits
 * nothing and constructs nothing (`new`) is a value and moves to module scope, under a name the module does not take;
 * every other statement runs per case, in order, before the check.
 */
const splitOf = (setup: ReadonlyArray<ts.Statement>, taken: ReadonlySet<string>): Split => {
	const declared = new Set(Arr.flatMap(setup, declaredNamesOf))
	return Arr.reduce(
		setup,
		{ lifted: [], prefix: [], perCase: new Set<string>() },
		(split: Split, statement): Split => {
			const names = declaredNamesOf(statement)
			const liftedNames = new Set(Arr.flatMap(split.lifted, declaredNamesOf))
			const pure =
				isDeclaration(statement) &&
				!ts.isClassDeclaration(statement) &&
				!ts.isEnumDeclaration(statement) &&
				Arr.isReadonlyArrayNonEmpty(names) &&
				!holds(statement, ts.SyntaxKind.YieldExpression) &&
				!holds(statement, ts.SyntaxKind.AwaitExpression) &&
				!holds(statement, ts.SyntaxKind.NewExpression) &&
				!(
					ts.isVariableStatement(statement) &&
					Arr.some(statement.declarationList.declarations, (d) => isMutable(d.initializer))
				) &&
				!Arr.some(names, (n) => taken.has(n)) &&
				!Arr.some(
					identifiersUnder(statement),
					(n) => declared.has(n) && !liftedNames.has(n) && !Arr.contains(names, n)
				)
			return pure
				? { ...split, lifted: [...split.lifted, statement] }
				: {
						...split,
						prefix: [...split.prefix, statement],
						perCase: new Set([...split.perCase, ...names])
					}
		}
	)
}

/** The yields a per-case setup makes, by what each yields: what a Template or a need would take over. */
const yieldsOf = (
	parsed: Parsed,
	statements: ReadonlyArray<ts.Statement>
): ReadonlyArray<string> => {
	const found: Array<string> = []
	const visit = (node: ts.Node): undefined => {
		if (ts.isYieldExpression(node) && node.expression !== undefined) {
			const yielded = unparenthesized(node.expression)
			found.push(ts.isCallExpression(yielded) ? calleeOf(parsed, yielded) : textOf(parsed, yielded))
		}
		node.forEachChild(visit)
		return undefined
	}
	Arr.forEach(statements, visit)
	return Arr.dedupe(found)
}

/** A wrapper as the check writes it: setup's lines and the names they declare, or the stages' texts. */
type Layer =
	| Readonly<{ kind: "setup"; lines: ReadonlyArray<string>; names: ReadonlyArray<string> }>
	| Readonly<{ kind: "stages"; stages: ReadonlyArray<string> }>

/**
 * The check's effect as it is written from the inside out: the property's body alone; an Effect.gen of setup lines
 * and its tail (`return yield*` of what it wraps, or the property body's own statements, inlined); or any other effect.
 */
type Wrapped =
	| Readonly<{ kind: "body" }>
	| Readonly<{
			kind: "gen"
			lines: ReadonlyArray<string>
			names: ReadonlyArray<string>
			tail: string
	  }>
	| Readonly<{ kind: "effect"; text: string }>

/** A wrapped effect's text, the body's being `body`. */
const rendered = (wrapped: Wrapped, body: string): string => {
	switch (wrapped.kind) {
		case "body":
			return body
		case "gen":
			return `Effect.gen(function* () {\n${Arr.join(wrapped.lines, "\n")}\n${wrapped.tail}\n})`
		case "effect":
			return wrapped.text
	}
}

/**
 * A property body that is a bare Effect.gen of a generator of no parameters: its statements' text, and the names they
 * declare, which setup around it may take in their place (`yield*` of a nested Effect.gen is inlined).
 */
const generatorBodyOf = (
	parsed: Parsed,
	body: ts.Expression
): Option.Option<Readonly<{ text: string; names: ReadonlyArray<string> }>> => {
	const bare = unparenthesized(body)
	const fn =
		ts.isCallExpression(bare) &&
		calleeOf(parsed, bare) === "Effect.gen" &&
		bare.arguments.length === 1
			? bare.arguments[0]
			: undefined
	const generator = fn === undefined ? undefined : unparenthesized(fn)
	return generator !== undefined &&
		ts.isFunctionExpression(generator) &&
		generator.asteriskToken !== undefined &&
		generator.parameters.length === 0
		? Option.some({
				text: Str.slice(
					generator.body.getStart(parsed.tree) + 1,
					generator.body.end - 1
				)(parsed.text),
				names: Arr.flatMap(generator.body.statements, declaredNamesOf)
			})
		: Option.none()
}

/** The parts of a property every field of a test's spec and setup gives. */
type Parts = Readonly<{
	space: Space
	situations: Situations
	oracle: ts.Expression
	box: Option.Option<Readonly<{ text: string; reads: ReadonlyArray<string> }>>
	callback: Callback
	provisions: ReadonlyArray<Provision>
}>

/**
 * Converts one test: its search's spec into the property's space, situations, oracle and box; its setup into module
 * constants (pure values) and the check's prefix (the rest, per case); its property into the check; and its layers into
 * needs and the services the check provides. Every name the module already takes is in `taken`.
 */
export const propertyOf = (module: Module, test: Test, taken: ReadonlySet<string>): Step<Built> => {
	const callback =
		test.call.arguments[1] === undefined ? undefined : unparenthesized(test.call.arguments[1])
	const ctx = Option.flatMap(Option.fromNullishOr(callback), (cb) =>
		ts.isArrowFunction(cb) &&
		cb.parameters[0] !== undefined &&
		ts.isIdentifier(cb.parameters[0].name)
			? Option.some(cb.parameters[0].name.text)
			: Option.none()
	)
	return Result.flatMap(searchOf(module, test, ctx), (search) => {
		const [spec, property] = search.call.arguments
		if (spec === undefined || property === undefined || search.call.arguments.length !== 2) {
			return refuse("spec-shape", lineAt(module, search.call), "a search not of (spec, property)")
		}
		return Result.flatMap(fieldsOf(module, search.kind, spec), (fields) => {
			const space: Step<Space> =
				search.kind === "explore"
					? Result.flatMap(required(module, fields, "draw", spec), (draw) =>
							Result.flatMap(spaceOfDraw(module, draw), (s) =>
								Result.map(caseListOf(module, firstArgumentOf(module, draw)), () => s)
							)
						)
					: Result.flatMap(required(module, fields, "generator", spec), (generator) =>
							Result.map(caseListOf(module, generator), (): Space => ({
								text: `finite(${textOf(module.parsed, generator)})`,
								reads: identifiersUnder(generator),
								resolve: Option.none(),
								wanted: [
									{
										module: module.api.gen,
										name: "finite",
										local: module.locals.finite,
										type: false
									}
								]
							}))
						)
			const steps = {
				space,
				situations: Result.flatMap(required(module, fields, "coverage", spec), (c) =>
					situationsOf(module, c)
				),
				oracle: required(module, fields, "oracle", spec),
				box:
					search.kind === "exhaust"
						? Result.map(boxOf(module, fields, spec), Option.some)
						: Result.succeed(
								Option.none<Readonly<{ text: string; reads: ReadonlyArray<string> }>>()
							),
				callback: callbackOf(module, property),
				provisions: provisionsOf(module, test),
				kept: keptOf(module, fields)
			}
			const refusals = Arr.flatMap(Rec.values(steps), (step: Step<unknown>) =>
				Result.isFailure(step) ? step.failure : []
			)
			return Arr.isReadonlyArrayNonEmpty(refusals)
				? Result.fail(refusals)
				: Result.flatMap(Result.all(steps), (parts) => builtOf(module, test, search, taken, parts))
		})
	})
}

/** A draw's generator: the first argument of drawn, aimed or sketched, followed to its definition. */
const firstArgumentOf = (module: Module, draw: ts.Expression): ts.Expression => {
	const bare = definitionOf(module, draw)
	return ts.isCallExpression(bare) && bare.arguments[0] !== undefined ? bare.arguments[0] : bare
}

/** A test's property, once every part of it converted: its check assembled, its export written. */
const builtOf = (
	module: Module,
	test: Test,
	search: Search,
	taken: ReadonlySet<string>,
	parts: Parts
): Step<Built> => {
	const { parsed } = module
	const split = splitOf(setupOf(search.wrappers), taken)
	const fromSetup = Arr.filter(
		[
			...parts.space.reads,
			...parts.situations.reads,
			...identifiersUnder(parts.oracle),
			...Option.match(parts.box, { onNone: () => [], onSome: (box) => box.reads })
		],
		(name) => split.perCase.has(name)
	)
	if (Arr.isReadonlyArrayNonEmpty(fromSetup)) {
		return refuse(
			"space-from-setup",
			lineAt(module, search.call),
			Arr.join(Arr.dedupe(fromSetup), ", ")
		)
	}
	const used = new Set([...namesUnder(test.call), ...taken])
	const needs = Arr.filter(
		parts.provisions,
		(p): p is Extract<Provision, { kind: "need" }> => p.kind === "need"
	)
	const resources = Arr.reduce(needs, Arr.empty<string>(), (names: ReadonlyArray<string>, need) => [
		...names,
		freshName(need.resource, new Set([...used, ...names]))
	])
	const sketch = freshName("sketch", used)
	const callback = parts.callback
	const vocabulary = parts.situations.vocabulary
	if (callback.kind === "reference" && Option.isNone(vocabulary)) {
		return refuse(
			"property-shape",
			lineAt(module, callback.expression),
			"a property passed by name, whose case vocabulary only its own type states"
		)
	}
	const parameterNames = (p: Option.Option<ts.ParameterDeclaration>) =>
		Option.match(p, { onNone: () => [], onSome: (d) => boundNamesOf(d.name) })
	const own =
		callback.kind === "literal"
			? [...parameterNames(callback.value), ...parameterNames(callback.c)]
			: []
	const shadowed = Arr.filter(Arr.flatMap(split.prefix, declaredNamesOf), (name) =>
		Arr.contains(
			[...own, ...resources, ...(Option.isSome(parts.space.resolve) ? [sketch] : [])],
			name
		)
	)
	if (Arr.isReadonlyArrayNonEmpty(shadowed)) {
		return refuse("setup-shadowed", lineAt(module, search.call), Arr.join(shadowed, ", "))
	}
	const typed = (name: string, type: Option.Option<string>) =>
		Option.match(type, { onNone: () => name, onSome: (t) => `${name}: ${t}` })
	const caseType = Option.orElse(
		Option.map(vocabulary, (v) => `${module.locals.Case}<${v}>`),
		() =>
			parts.situations.text === "[]" ? Option.some(`${module.locals.Case}<string>`) : Option.none()
	)
	const valueName = freshName("value", used)
	const caseName = freshName("c", used)
	const value: Option.Option<string> =
		callback.kind === "literal"
			? Option.map(callback.value, (p) => textOf(parsed, p))
			: Option.some(valueName)
	const caseParameter: Option.Option<string> =
		callback.kind === "literal"
			? Option.map(callback.c, (p) =>
					typed(
						textOf(parsed, p.name),
						p.type === undefined ? caseType : Option.some(textOf(parsed, p.type))
					)
				)
			: Option.some(typed(caseName, caseType))
	const resolveStatement = Option.map(parts.space.resolve, (resolve) =>
		Option.match(value, {
			onNone: () => `;(${resolve})(${sketch})`,
			onSome: (v) => `const ${v} = (${resolve})(${sketch})`
		})
	)
	const valueParameter = Option.isSome(parts.space.resolve) ? Option.some(sketch) : value
	const bodyIsBlock = callback.kind === "literal" && ts.isBlock(callback.body)
	const bodyText =
		callback.kind === "literal"
			? textOf(parsed, callback.body)
			: `(${textOf(parsed, callback.expression)})(${valueName}, ${caseName})`
	const lifted = new Set<ts.Statement>(split.lifted)
	const resolveNames = Option.match(callback.kind === "literal" ? callback.value : Option.none(), {
		onNone: () => [],
		onSome: (p) => (Option.isSome(parts.space.resolve) ? boundNamesOf(p.name) : [])
	})
	const layers: ReadonlyArray<Layer> = [
		...Arr.map(search.wrappers, (w): Layer =>
			w.kind === "setup"
				? (() => {
						const kept = Arr.filter(w.statements, (st) => !lifted.has(st))
						return {
							kind: "setup",
							lines: Arr.map(kept, (st) => withCommentsOf(parsed, st)),
							names: Arr.flatMap(kept, declaredNamesOf)
						}
					})()
				: { kind: "stages", stages: Arr.map(w.stages, (st) => textOf(parsed, st)) }
		),
		{ kind: "setup", lines: Option.toArray(resolveStatement), names: resolveNames }
	]
	const bodyExpression = bodyIsBlock ? `Effect.suspend(() => ${bodyText})` : bodyText
	const inlined =
		callback.kind === "literal" && !ts.isBlock(callback.body)
			? generatorBodyOf(parsed, callback.body)
			: Option.none()
	const perCase = [...Arr.flatMap(split.prefix, declaredNamesOf), ...resolveNames]
	const redeclared = Option.match(inlined, {
		onNone: () => [],
		onSome: (body) => Arr.filter(body.names, (name) => Arr.contains(perCase, name))
	})
	if (Arr.isReadonlyArrayNonEmpty(redeclared) && Arr.isReadonlyArrayNonEmpty(split.prefix)) {
		return refuse(
			"setup-shadowed",
			lineAt(module, search.call),
			`the property's body declares ${Arr.join(redeclared, ", ")} as its setup does`
		)
	}
	const wrapped = Arr.reduceRight(layers, { kind: "body" }, (inner: Wrapped, layer): Wrapped => {
		if (layer.kind === "stages") {
			const stages = Arr.filter(
				layer.stages,
				(st) => inner.kind !== "body" || st !== "Effect.scoped"
			)
			return Arr.isReadonlyArrayNonEmpty(stages)
				? {
						kind: "effect",
						text: `(${rendered(inner, bodyExpression)}).pipe(${Arr.join(stages, ", ")})`
					}
				: inner
		}
		if (!Arr.isReadonlyArrayNonEmpty(layer.lines)) {
			return inner
		}
		const apart = (names: ReadonlyArray<string>) =>
			!Arr.some(names, (n) => Arr.contains(layer.names, n))
		switch (inner.kind) {
			case "body":
				return Option.match(
					Option.filter(inlined, (body) => apart(body.names)),
					{
						onNone: (): Wrapped => ({
							kind: "gen",
							lines: layer.lines,
							names: layer.names,
							tail: `return yield* ${bodyExpression}`
						}),
						onSome: (body): Wrapped => ({
							kind: "gen",
							lines: layer.lines,
							names: [...layer.names, ...body.names],
							tail: body.text
						})
					}
				)
			case "gen":
				return apart(inner.names)
					? {
							kind: "gen",
							lines: [...layer.lines, ...inner.lines],
							names: [...layer.names, ...inner.names],
							tail: inner.tail
						}
					: {
							kind: "gen",
							lines: layer.lines,
							names: layer.names,
							tail: `return yield* ${rendered(inner, bodyExpression)}`
						}
			case "effect":
				return {
					kind: "gen",
					lines: layer.lines,
					names: layer.names,
					tail: `return yield* ${inner.text}`
				}
		}
	})
	const piped =
		wrapped.kind === "body"
			? bodyIsBlock && Arr.some(parts.provisions, (p) => p.kind !== "ambient")
				? bodyExpression
				: bodyText
			: rendered(wrapped, bodyExpression)
	const provided = Arr.reduceRight(parts.provisions, piped, (effect, provision) => {
		switch (provision.kind) {
			case "ambient":
				return effect
			case "layer":
				return `Effect.provide(${effect}, ${provision.text})`
			case "need":
				return `Effect.provideServiceEffect(${effect}, ${provision.service}, ${resources[needs.indexOf(provision)] ?? provision.resource})`
		}
	})
	const resourcesParameter = Arr.isReadonlyArrayNonEmpty(resources)
		? Option.some(`{ ${Arr.join(resources, ", ")} }`)
		: Option.map(caseParameter, () => freshName("_", used))
	const outer = Arr.join(
		[...Option.toArray(resourcesParameter), ...Option.toArray(caseParameter)],
		", "
	)
	const check = `(${outer}) => (${Option.getOrElse(valueParameter, () => "")}) => ${provided}`
	const name = freshName(camelOf(test), taken)
	const fields = [
		`needs: { ${Arr.join(
			Arr.map(needs, (need, i) => `${resources[i] ?? need.resource}: ${need.need}`),
			", "
		)} }`,
		`situations: ${Option.match(vocabulary, {
			onNone: () => parts.situations.text,
			onSome: (v) =>
				`${parts.situations.text} satisfies ReadonlyArray<${module.locals.Reached}<${v}>>`
		})}`,
		`check: ${check}`,
		`oracle: ${textOf(parsed, parts.oracle)}`,
		...Option.toArray(Option.map(parts.box, (box) => `box: ${box.text}`)),
		"kept: []",
		"kills: []"
	]
	const effects = yieldsOf(parsed, split.prefix)
	const clocked = test.frame.testServices && !test.live && CLOCKED.test(textOf(parsed, test.call))
	return Result.succeed({
		name,
		lifted: split.lifted,
		text: `/** ${sentenceOf(test)} */\nexport const ${name} = ${module.locals.property}.${search.kind}(${parts.space.text}, {\n${Arr.join(fields, ",\n")}\n})`,
		wanted: [
			{ module: module.api.property, name: "property", local: module.locals.property, type: false },
			...parts.space.wanted,
			...(Option.isSome(caseType) && Option.isSome(caseParameter)
				? [{ module: module.api.property, name: "Case", local: module.locals.Case, type: true }]
				: []),
			...(Option.isSome(vocabulary)
				? [
						{
							module: module.api.features,
							name: "Reached",
							local: module.locals.Reached,
							type: true
						}
					]
				: []),
			...Arr.flatMap(needs, (need) => need.imports)
		],
		notes: [
			...(Arr.isReadonlyArrayNonEmpty(effects)
				? [
						{
							code: "setup-per-case" as const,
							line: lineAt(module, search.call),
							detail: `${name}: ${Arr.join(effects, ", ")}`
						}
					]
				: []),
			...(clocked
				? [{ code: "test-services" as const, line: lineAt(module, test.call), detail: name }]
				: [])
		]
	})
}
