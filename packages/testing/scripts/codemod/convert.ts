import { Array as Arr, Option, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import { headerOf, withoutPlantsIn } from "#codemod/header.ts"
import { doorOf, importsFor, localsOf } from "#codemod/imports.ts"
import type { Plugin, Wanted } from "#codemod/plugin.ts"
import {
	apiOf,
	type Binding,
	importsOf,
	OLD,
	type Piece,
	piecesOf,
	type Step
} from "#codemod/registrations.ts"
import type { Finding, Reported } from "#codemod/report.ts"
import { type Built, type Module, propertyOf } from "#codemod/search.ts"
import {
	boundNamesOf,
	declaredNamesOf,
	identifiersUnder,
	lineOf,
	namesUnder,
	type Parsed,
	type Parser,
	textOf,
	unparenthesized,
	withCommentsOf
} from "#codemod/syntax.ts"

/**
 * Where a test module's fixtures go: the module beside it that holds what its properties read (generators, models,
 * helpers, types), since a test module holds properties only; its path from the repository root and the specifier the
 * test module imports it by. A place the repository's import maps cannot name is a reason, given as text.
 */
export type Place = Result.Result<Readonly<{ file: string; specifier: string }>, string>

/** A converted module's text, and its fixtures module's when it has one. */
export type Output = Readonly<{
	test: string
	fixtures: Option.Option<Readonly<{ file: string; text: string }>>
}>

/** A module's report and, when it converted, what it converted to. */
export type Outcome = Reported & Readonly<{ output: Option.Option<Output> }>

/** How many times each name is read across a set of nodes. */
const readsOf = (nodes: ReadonlyArray<ts.Node>): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>()
	for (const name of Arr.flatMap(nodes, identifiersUnder)) {
		counts.set(name, (counts.get(name) ?? 0) + 1)
	}
	return counts
}

/**
 * The fixtures without the declarations the conversion left unread: a declaration none of whose names is read by the
 * other fixtures or by the test module (`outside`), though the original module read it, goes with its JSDoc (a
 * coverage constant, a literal printer, a run count), and the removal repeats until none is left.
 */
const withoutDead = (
	parser: Parser,
	file: string,
	body: string,
	outside: ReadonlySet<string>,
	removable: (name: string) => boolean
): Readonly<{ body: string; removed: ReadonlyArray<string> }> => {
	const statements = parser.parse(file, body).tree.statements
	const dead = Arr.findFirst(statements, (statement) => {
		const names = declaredNamesOf(statement)
		if (!Arr.isReadonlyArrayNonEmpty(names)) {
			return false
		}
		const reads = readsOf(Arr.filter(statements, (s) => s !== statement))
		return Arr.every(
			names,
			(name) => (reads.get(name) ?? 0) === 0 && !outside.has(name) && removable(name)
		)
	})
	return Option.match(dead, {
		onNone: () => ({ body, removed: [] }),
		onSome: (statement) => {
			const next = withoutDead(
				parser,
				file,
				`${Str.slice(0, statement.pos)(body)}\n${Str.slice(statement.end)(body)}`,
				outside,
				removable
			)
			return { body: next.body, removed: [...declaredNamesOf(statement), ...next.removed] }
		}
	})
}

/**
 * The fixtures with `export` before each declaration the test module reads, and the names it exports, each with
 * whether a type-only import takes it.
 */
const exported = (
	parser: Parser,
	file: string,
	body: string,
	read: ReadonlySet<string>
): Readonly<{ body: string; names: ReadonlyArray<readonly [string, boolean]> }> => {
	const parsed = parser.parse(file, body)
	const shared = Arr.filter(parsed.tree.statements, (s) =>
		Arr.some(declaredNamesOf(s), (name) => read.has(name))
	)
	const text = Arr.reduceRight(shared, body, (acc, statement) => {
		const at = statement.getStart(parsed.tree)
		return `${Str.slice(0, at)(acc)}export ${Str.slice(at)(acc)}`
	})
	return {
		body: text,
		names: Arr.flatMap(shared, (s) =>
			Arr.map(
				Arr.filter(declaredNamesOf(s), (name) => read.has(name)),
				(name) => [name, ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)] as const
			)
		)
	}
}

/** The module scope's names: its imports' and its top-level declarations', and its describes' declarations. */
const namesOfModule = (parsed: Parsed, pieces: ReadonlyArray<Piece>): ReadonlySet<string> =>
	new Set([
		...Arr.flatMap(parsed.tree.statements, (s) =>
			ts.isImportDeclaration(s) ? namesUnder(s) : declaredNamesOf(s)
		),
		...Arr.flatMap(pieces, (p) => (p.kind === "declaration" ? declaredNamesOf(p.statement) : []))
	])

/** Constants by name, across the module and its describes: what a spec's identifier field is followed to. */
const constantsOf = (
	parsed: Parsed,
	pieces: ReadonlyArray<Piece>
): ReadonlyMap<string, ts.Expression> => {
	const statements: ReadonlyArray<ts.Statement> = [
		...parsed.tree.statements,
		...Arr.flatMap(pieces, (p) => (p.kind === "declaration" ? [p.statement] : []))
	]
	return new Map(
		Arr.flatMap(statements, (s): ReadonlyArray<readonly [string, ts.Expression]> =>
			ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const) !== 0
				? Arr.flatMap(s.declarationList.declarations, (d) =>
						ts.isIdentifier(d.name) && d.initializer !== undefined
							? [[d.name.text, d.initializer] as const]
							: []
					)
				: []
		)
	)
}

/** Whether a top-level statement is exported: another module may import it from the test module. */
const isExported = (statement: ts.Statement): boolean =>
	Arr.some(
		ts.isVariableStatement(statement) ||
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement)
			? (statement.modifiers ?? [])
			: [],
		(m) => m.kind === ts.SyntaxKind.ExportKeyword
	)

/**
 * What lifting the describes' declarations to module scope, and moving the module's to its fixtures, would break: two
 * declarations under one name, or a declaration another module imports from the test module.
 */
const collisionsOf = (
	parsed: Parsed,
	pieces: ReadonlyArray<Piece>,
	imports: ReadonlyMap<string, Binding>
): ReadonlyArray<Finding> => {
	const lifted = Arr.flatMap(pieces, (p) =>
		p.kind === "declaration" && p.statement.parent !== parsed.tree
			? Arr.map(declaredNamesOf(p.statement), (name) => [name, p.statement] as const)
			: []
	)
	const top = new Set(
		Arr.flatMap(parsed.tree.statements, (s) =>
			ts.isImportDeclaration(s) ? namesUnder(s) : declaredNamesOf(s)
		)
	)
	const collided = Arr.filterMap(lifted, ([name, statement], i) =>
		top.has(name) || Arr.some(lifted, ([other], j) => j < i && other === name)
			? Result.succeed<Finding>({
					code: "hoist-collision",
					line: lineOf(parsed, statement),
					detail: name
				})
			: Result.failVoid
	)
	const named = Arr.filterMap(parsed.tree.statements, (s) => {
		const names = Arr.filter(declaredNamesOf(s), (name) => imports.has(name))
		return Arr.isReadonlyArrayNonEmpty(names)
			? Result.succeed<Finding>({
					code: "shared-name",
					line: lineOf(parsed, s),
					detail: Arr.join(names, ", ")
				})
			: Result.failVoid
	})
	const shared = Arr.filterMap(parsed.tree.statements, (s) =>
		isExported(s)
			? Result.succeed<Finding>({
					code: "exported-helper",
					line: lineOf(parsed, s),
					detail: Arr.join(declaredNamesOf(s), ", ")
				})
			: Result.failVoid
	)
	return [...collided, ...named, ...shared]
}

/** The tests converted so far, and every name the module takes with their exports and lifted setup. */
type Building = Readonly<{ taken: ReadonlySet<string>; steps: ReadonlyArray<Step<Built>> }>

/**
 * The two modules' texts so far, piece by piece, and the next converted test's index: the test module's properties,
 * the fixtures' declarations in source order, and the setup values lifted from the tests, which follow every declaration
 * since a test's setup ran only once the whole module had.
 */
type Writing = Readonly<{
	index: number
	test: ReadonlyArray<string>
	fixtures: ReadonlyArray<string>
	lifted: ReadonlyArray<string>
}>

/** A module left to a person, with its reasons; or one with no search at all, which this codemod does not read. */
const refusedWith = (parsed: Parsed, findings: ReadonlyArray<Finding>): Outcome => {
	const searches = Str.includes("searched(")(parsed.text)
	return {
		file: parsed.file,
		status: searches ? "hand" : "not-a-search",
		findings: searches ? findings : [],
		output: Option.none()
	}
}

/**
 * What a converted module still reads of the old search API: a search, a draw, a coverage or searched itself, run
 * inside a property or a helper (a search nested in a case), which only a person can turn into a property or a harness.
 */
const oldApiOf = (
	imports: ReadonlyMap<string, Binding>,
	reads: ReadonlyArray<string>
): ReadonlyArray<Finding> =>
	Arr.map(
		Arr.dedupe(
			Arr.filter(reads, (local) => {
				const binding = imports.get(local)
				return (
					binding !== undefined &&
					((Arr.contains(OLD.explore, binding.module) &&
						Arr.contains(
							["explore", "exhaust", "drawn", "aimed", "sketched", "steered", "Run"],
							binding.name
						)) ||
						Arr.contains(OLD.searched, binding.module) ||
						(Arr.contains(OLD.features, binding.module) &&
							Arr.contains(["required", "requiredInSpace", "rating", "noCoverage"], binding.name)))
				)
			})
		),
		(local): Finding => ({ code: "nested-search", line: 1, detail: local })
	)

/**
 * A fixture the test module reads that is a function of no parameters returning an Effect (`const open = () =>
 * Effect.gen(...)`): exported, it is a lazy Effect the language service refuses, and making it the Effect itself
 * rewrites every property that calls it, which the codemod never does.
 */
const lazyExportsOf = (fixtures: Parsed): ReadonlyArray<Finding> =>
	Arr.flatMap(fixtures.tree.statements, (statement) =>
		ts.isVariableStatement(statement) &&
		Arr.some(statement.modifiers ?? [], (m) => m.kind === ts.SyntaxKind.ExportKeyword)
			? Arr.filterMap(statement.declarationList.declarations, (d) => {
					const init = d.initializer === undefined ? undefined : unparenthesized(d.initializer)
					return init !== undefined &&
						ts.isArrowFunction(init) &&
						init.parameters.length === 0 &&
						!ts.isBlock(init.body) &&
						Str.startsWith("Effect.")(textOf(fixtures, init.body))
						? Result.succeed<Finding>({
								code: "lazy-effect-export",
								line: 1,
								detail: Arr.join(boundNamesOf(d.name), ", ")
							})
						: Result.failVoid
				})
			: []
	)

/** The failures of a result, none for a success. */
const failuresOf = <A>(result: Result.Result<A, ReadonlyArray<Finding>>): ReadonlyArray<Finding> =>
	Result.isFailure(result) ? result.failure : []

/**
 * Converts one test module, whole or not at all: every test becomes an exported property; what its properties read
 * (the module's declarations, the describes' and the setup's values) moves to its fixtures module beside it, each
 * declaration the test module reads exported there; the header loses its plant citations; both modules' imports are
 * rebuilt; and the declarations only the dropped fields read go. A module with no search is not one this codemod
 * converts.
 */
export const convert = (parser: Parser, plugin: Plugin, parsed: Parsed, place: Place): Outcome => {
	const imports: ReadonlyMap<string, Binding> = importsOf(parsed)
	const api = apiOf(imports)
	const pieces = piecesOf(parsed, plugin, imports)
	if (Result.isFailure(pieces)) {
		return refusedWith(parsed, pieces.failure)
	}
	const collisions = collisionsOf(parsed, pieces.success, imports)
	if (Arr.isReadonlyArrayNonEmpty(collisions)) {
		return refusedWith(parsed, collisions)
	}
	const locals = localsOf(parsed, pieces.success, imports)
	const module: Module = {
		parsed,
		plugin,
		imports,
		constants: constantsOf(parsed, pieces.success),
		api,
		locals
	}
	const built = Arr.reduce(
		pieces.success,
		{
			taken: new Set([
				...namesOfModule(parsed, pieces.success),
				locals.property,
				locals.Case,
				locals.Reached,
				locals.finite,
				locals.aimed
			]),
			steps: []
		},
		(state: Building, piece): Building => {
			if (piece.kind !== "test") {
				return state
			}
			const step = propertyOf(module, piece.test, state.taken)
			return {
				taken: Result.isSuccess(step)
					? new Set([
							...state.taken,
							step.success.name,
							...Arr.flatMap(step.success.lifted, declaredNamesOf)
						])
					: state.taken,
				steps: [...state.steps, step]
			}
		}
	)
	const refusals = Arr.flatMap(built.steps, failuresOf)
	const properties = Arr.flatMap(built.steps, (s) => (Result.isSuccess(s) ? [s.success] : []))
	if (Arr.isReadonlyArrayNonEmpty(refusals) || !Arr.isReadonlyArrayNonEmpty(properties)) {
		return refusedWith(
			parsed,
			Arr.isReadonlyArrayNonEmpty(refusals)
				? refusals
				: [{ code: "not-searched", line: 1, detail: "no test in the module runs a search" }]
		)
	}
	const written = Arr.reduce(
		pieces.success,
		{ index: 0, test: [], fixtures: [], lifted: [] },
		(state: Writing, piece): Writing => {
			switch (piece.kind) {
				case "declaration":
					return {
						...state,
						fixtures: [...state.fixtures, withCommentsOf(parsed, piece.statement)]
					}
				case "comments":
					return { ...state, test: [...state.test, piece.text] }
				case "test": {
					const property = properties[state.index]
					return property === undefined
						? state
						: {
								...state,
								index: state.index + 1,
								test: [...state.test, property.text],
								lifted: [
									...state.lifted,
									...Arr.map(property.lifted, (s) => withCommentsOf(parsed, s))
								]
							}
				}
			}
		}
	)
	const testBody = Arr.join(written.test, "\n\n")
	const original = readsOf([parsed.tree])
	const liftedNames = new Set([
		...Arr.flatMap(properties, (p) => Arr.flatMap(p.lifted, declaredNamesOf)),
		...Arr.flatMap(pieces.success, (p) =>
			p.kind === "declaration" && p.statement.parent !== parsed.tree
				? declaredNamesOf(p.statement)
				: []
		)
	])
	const testReads = new Set(identifiersUnder(parser.parse(parsed.file, testBody).tree))
	const fixturesFile = Result.match(place, {
		onFailure: () => parsed.file,
		onSuccess: (p) => p.file
	})
	const pruned = withoutDead(
		parser,
		fixturesFile,
		Arr.join([...written.fixtures, ...written.lifted], "\n\n"),
		testReads,
		(name) => (original.get(name) ?? 0) > 0 || liftedNames.has(name)
	)
	const shared = exported(parser, fixturesFile, pruned.body, testReads)
	const fixturesReads = new Set(identifiersUnder(parser.parse(fixturesFile, shared.body).tree))
	const hasFixtures = Str.isNonEmpty(Str.trim(shared.body))
	const testDoor = doorOf(imports, testReads, api)
	const fixturesDoor = doorOf(imports, fixturesReads, api)
	const fresh = new Set([locals.property, locals.Case, locals.Reached, locals.finite, locals.aimed])
	const leftovers = [
		...oldApiOf(
			imports,
			Arr.filter([...testReads], (name) => !fresh.has(name))
		),
		...oldApiOf(imports, [...fixturesReads])
	]
	const lazy = lazyExportsOf(parser.parse(fixturesFile, shared.body))
	const late = [...failuresOf(testDoor), ...failuresOf(fixturesDoor), ...leftovers, ...lazy]
	if (Arr.isReadonlyArrayNonEmpty(late)) {
		return refusedWith(parsed, late)
	}
	if (hasFixtures && Result.isFailure(place)) {
		return refusedWith(parsed, [{ code: "fixtures-place", line: 1, detail: place.failure }])
	}
	const fromFixtures: ReadonlyArray<Wanted> = Result.match(place, {
		onFailure: () => [],
		onSuccess: (p) =>
			Arr.map(shared.names, ([name, type]) => ({
				module: p.specifier,
				name,
				local: name,
				type
			}))
	})
	const header = headerOf(parsed)
	const testImports = importsFor(
		parsed,
		imports,
		testReads,
		[
			...Arr.flatMap(properties, (p) => p.wanted),
			...Result.getOrElse(testDoor, () => []),
			...fromFixtures
		],
		api,
		true
	)
	const fixturesImports = importsFor(
		parsed,
		imports,
		fixturesReads,
		Result.getOrElse(fixturesDoor, () => []),
		api,
		false
	)
	const joined = (parts: ReadonlyArray<string>) =>
		`${Arr.join(Arr.filter(parts, Str.isNonEmpty), "\n\n")}\n`
	const name = Arr.lastNonEmpty(Str.split(parsed.file, "/"))
	const test = withoutPlantsIn(joined([header, testImports, Str.trim(testBody)]))
	const fixtures = withoutPlantsIn(
		joined([
			`/** What the properties of ${name} read: its spaces, models and helpers. */`,
			fixturesImports,
			Str.trim(shared.body)
		])
	)
	const removed = [...test.removed, ...fixtures.removed]
	const notes: ReadonlyArray<Finding> = [
		...Arr.flatMap(properties, (p) => p.notes),
		...(Arr.isReadonlyArrayNonEmpty(removed)
			? [
					{
						code: "plant-citations" as const,
						line: 1,
						detail: `${Arr.join(
							Arr.map(properties, (p) => p.name),
							" "
						)}: ${Arr.join(removed, " ")}`
					}
				]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(pruned.removed)
			? [{ code: "dead-declarations" as const, line: 1, detail: Arr.join(pruned.removed, ", ") }]
			: [])
	]

	return {
		file: parsed.file,
		status: "converted",
		findings: notes,
		output: Option.some({
			test: test.text,
			fixtures: Result.match(place, {
				onFailure: () => Option.none(),
				onSuccess: (p) =>
					hasFixtures ? Option.some({ file: p.file, text: fixtures.text }) : Option.none()
			})
		})
	}
}
