import { Array as Arr, Option, Order, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Wanted } from "#codemod/plugin.ts"
import { type Api, type Binding, OLD, type Piece, VITEST_MODULES } from "#codemod/registrations.ts"
import type { Finding } from "#codemod/report.ts"
import { freshName, type Locals } from "#codemod/search.ts"
import { declaredNamesOf, namesUnder, type Parsed, stringValueOf, textOf } from "#codemod/syntax.ts"

/** The old API's names a test module no longer reads: the searches and their draws, replaced by `property`'s. */
const REPLACED: ReadonlyArray<string> = [
	"drawn",
	"aimed",
	"sketched",
	"steered",
	"explore",
	"exhaust"
]

/** The old API's types the property module states now: a module reading one imports it from there. */
const MOVED: ReadonlyArray<string> = ["Case", "Oracle"]

/**
 * The names the assert door exports (@bjornpagen/testing/assert): what a module read from @effect/vitest/utils, or
 * `assert` from @effect/vitest, it reads from the door, under the same name.
 */
const DOOR: ReadonlyArray<string> = [
	"assert",
	"assertEquals",
	"assertExitSuccess",
	"assertFalse",
	"assertInclude",
	"assertInstanceOf",
	"assertMatch",
	"assertNone",
	"assertSameMembers",
	"assertSome",
	"assertTrue",
	"deepStrictEqual",
	"fail",
	"strictEqual",
	"throws"
]

/** A specifier's text as a module imports it: `name`, `type name`, `name as local`. */
const specifierText = (w: Wanted, typeOnly: boolean): string =>
	`${w.type && !typeOnly ? "type " : ""}${w.name === w.local ? w.name : `${w.name} as ${w.local}`}`

const moduleOf = (d: ts.ImportDeclaration): string =>
	Option.getOrElse(stringValueOf(d.moduleSpecifier), () => "")

/** An import declaration's text, with only the specifiers kept and the wanted ones added, sorted by name. */
const importTextOf = (
	statement: ts.ImportDeclaration,
	keep: (local: string) => boolean,
	added: ReadonlyArray<Wanted>
): Option.Option<string> => {
	const clause = statement.importClause
	if (clause === undefined) {
		return Option.some(textOf(statement))
	}
	const typeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword
	const named = clause.namedBindings
	const defaultName = Option.filter(Option.fromNullishOr(clause.name?.text), keep)
	const namespace =
		named !== undefined && ts.isNamespaceImport(named) && keep(named.name.text)
			? Option.some(`* as ${named.name.text}`)
			: Option.none()
	const chosen = Arr.sort(
		[
			...(named !== undefined && ts.isNamedImports(named)
				? Arr.filterMap(named.elements, (e) =>
						keep(e.name.text)
							? Result.succeed({
									local: e.name.text,
									bare:
										e.propertyName === undefined
											? e.name.text
											: `${textOf(e.propertyName)} as ${e.name.text}`,
									type: typeOnly || e.isTypeOnly
								})
							: Result.failVoid
					)
				: []),
			...Arr.map(added, (w) => ({
				local: w.local,
				bare: w.name === w.local ? w.name : `${w.name} as ${w.local}`,
				type: typeOnly || w.type
			}))
		],
		Order.mapInput(Order.String, (c: Readonly<{ local: string }>) => Str.toLowerCase(c.local))
	)
	const types =
		typeOnly ||
		(Option.isNone(defaultName) &&
			Option.isNone(namespace) &&
			Arr.isReadonlyArrayNonEmpty(chosen) &&
			Arr.every(chosen, (c) => c.type))
	const specifiers = Arr.map(chosen, (c) => (c.type && !types ? `type ${c.bare}` : c.bare))
	const parts = [
		...Option.toArray(defaultName),
		...Option.toArray(namespace),
		...(Arr.isReadonlyArrayNonEmpty(specifiers) ? [`{ ${Arr.join(specifiers, ", ")} }`] : [])
	]
	const attributes = statement.attributes === undefined ? "" : ` ${textOf(statement.attributes)}`
	return Arr.isReadonlyArrayNonEmpty(parts)
		? Option.some(
				`import ${types ? "type " : ""}${Arr.join(parts, ", ")} from ${textOf(statement.moduleSpecifier)}${attributes}`
			)
		: Option.none()
}

/**
 * What a converted body reads from Vitest's modules becomes an import of the assert door, by the same name; a name the
 * door does not export, or any other of Vitest's (expect, TestContext, vi), is a refusal.
 */
export const doorOf = (
	imports: ReadonlyMap<string, Binding>,
	reads: ReadonlySet<string>,
	api: Api
): Result.Result<ReadonlyArray<Wanted>, ReadonlyArray<Finding>> => {
	const fromVitest = Arr.filterMap([...reads], (local) => {
		const binding = imports.get(local)
		return binding !== undefined && Arr.contains(VITEST_MODULES, binding.module)
			? Result.succeed([local, binding] as const)
			: Result.failVoid
	})
	const doored = (binding: Binding) =>
		(binding.module === "@effect/vitest/utils" && Arr.contains(DOOR, binding.name)) ||
		(binding.module === "@effect/vitest" && binding.name === "assert")
	const refused = Arr.filter(fromVitest, ([, binding]) => !doored(binding))
	return Arr.isReadonlyArrayNonEmpty(refused)
		? Result.fail(
				Arr.map(refused, ([local, binding]) => ({
					code: "vitest-api" as const,
					line: 1,
					detail: `${local} from ${binding.module}`
				}))
			)
		: Result.succeed(
				Arr.map(fromVitest, ([local, binding]) => ({
					module: api.assert,
					name: binding.name,
					local,
					type: false
				}))
			)
}

/**
 * A module's imports for a converted body: Vitest's and the old search API's adapter go, the old searches and draws go
 * when `replaced` says so, every specifier the body no longer reads goes, a moved type is imported from the property
 * module, and each wanted name is added to a value import of its module or a new one.
 */
export const importsFor = (
	parsed: Parsed,
	imports: ReadonlyMap<string, Binding>,
	reads: ReadonlySet<string>,
	wanted: ReadonlyArray<Wanted>,
	api: Api,
	replaced: boolean
): string => {
	const declarations = Arr.filter(parsed.tree.statements, ts.isImportDeclaration)
	const kept = Arr.filter(declarations, (d) => !Arr.contains(VITEST_MODULES, moduleOf(d)))
	const moved = Arr.filter(MOVED, (name) => {
		const binding = imports.get(name)
		return (
			replaced &&
			reads.has(name) &&
			binding !== undefined &&
			Arr.contains(OLD.explore, binding.module) &&
			binding.name === name
		)
	})
	const all: ReadonlyArray<Wanted> = [
		...wanted,
		...Arr.map(moved, (name): Wanted => ({ module: api.property, name, local: name, type: true }))
	]
	const wantedOnce = Arr.dedupeWith(all, (a, b) => a.module === b.module && a.local === b.local)
	const present = (w: Wanted) =>
		Arr.some(declarations, (d) => {
			const named = d.importClause?.namedBindings
			return (
				moduleOf(d) === w.module &&
				named !== undefined &&
				ts.isNamedImports(named) &&
				Arr.some(named.elements, (e) => e.name.text === w.local)
			)
		})
	const toAdd = Arr.filter(wantedOnce, (w) => !present(w))
	const host = (module: string) =>
		Arr.findFirst(
			kept,
			(d) =>
				moduleOf(d) === module &&
				d.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
				d.importClause?.namedBindings !== undefined &&
				ts.isNamedImports(d.importClause.namedBindings)
		)
	const hosted = Arr.filter(toAdd, (w) => Option.isSome(host(w.module)))
	const fresh = Arr.filter(toAdd, (w) => Option.isNone(host(w.module)))
	const rewritten = Arr.filterMap(kept, (d) => {
		const module = moduleOf(d)
		const old = replaced && Arr.contains(OLD.explore, module)
		const keep = (local: string) =>
			(reads.has(local) &&
				!(old && (Arr.contains(REPLACED, local) || Arr.contains(moved, local)))) ||
			Arr.some(wantedOnce, (w) => w.module === module && w.local === local)
		const added = Option.match(host(module), {
			onNone: () => [],
			onSome: (h) => (h === d ? Arr.filter(hosted, (w) => w.module === module) : [])
		})
		return Option.match(importTextOf(d, keep, added), {
			onNone: () => Result.failVoid,
			onSome: Result.succeed
		})
	})
	const created = Arr.map(Arr.dedupe(Arr.map(fresh, (w) => w.module)), (module) => {
		const names = Arr.sort(
			Arr.filter(fresh, (w) => w.module === module),
			Order.mapInput(Order.String, (w: Wanted) => Str.toLowerCase(w.local))
		)
		const typeOnly = Arr.every(names, (w) => w.type)
		return `import ${typeOnly ? "type " : ""}{ ${Arr.join(
			Arr.map(names, (w) => specifierText(w, typeOnly)),
			", "
		)} } from "${module}"`
	})
	return Arr.join([...created, ...rewritten], "\n")
}

/**
 * The local names a module leaves the new API: each its own name, unless a declaration of the module, or an import
 * the conversion keeps, takes it, then a fresh one.
 */
export const localsOf = (
	parsed: Parsed,
	pieces: ReadonlyArray<Piece>,
	imports: ReadonlyMap<string, Binding>
): Locals => {
	const goes = (local: string) => {
		const binding = imports.get(local)
		return (
			binding !== undefined &&
			(Arr.contains(VITEST_MODULES, binding.module) ||
				(Arr.contains(OLD.explore, binding.module) &&
					(Arr.contains(REPLACED, binding.name) || Arr.contains(MOVED, binding.name))) ||
				(Arr.contains(OLD.gen, binding.module) && binding.name === local) ||
				(Arr.contains(OLD.features, binding.module) && binding.name === local))
		)
	}
	const taken = new Set([
		...Arr.filter(
			Arr.flatMap(parsed.tree.statements, (s) =>
				ts.isImportDeclaration(s) ? namesUnder(s) : declaredNamesOf(s)
			),
			(name) => !goes(name)
		),
		...Arr.flatMap(pieces, (p) => (p.kind === "declaration" ? declaredNamesOf(p.statement) : []))
	])
	const local = (name: string) => (taken.has(name) ? freshName(`${name}Of`, taken) : name)
	return {
		property: local("property"),
		Case: local("Case"),
		Reached: local("Reached"),
		finite: local("finite"),
		aimed: local("aimed")
	}
}
