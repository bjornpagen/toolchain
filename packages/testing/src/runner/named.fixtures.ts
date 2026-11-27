import { Array as Arr, Effect, FileSystem, Result, String as Str } from "effect"
import { subset } from "#gen.ts"
import { UNRUN_BUDGET } from "#runner/budgets.fixtures.ts"
import type { Discovered, LoadFailed } from "#runner/load.ts"

/**
 * What the named-arguments property (named.test.ts) draws, and the scratch package its check loads: a runner config
 * including `test/*.test.ts`; test/has.test.ts exporting a property and a family of two; test/none.test.ts, included,
 * exporting nothing; and other/outside.test.ts, a test module on disk the include leaves out.
 */

/** The properties the scratch package's included modules export, in discovery order. */
const included = [
	"test/has.test.ts#one",
	"test/has.test.ts#pair/a",
	"test/has.test.ts#pair/b"
] as const

/** A property the package's included modules export, by identity. */
type IncludedId = (typeof included)[number]

/**
 * An argument a command takes and what it names of the scratch package, by the specification: the included properties
 * it names, or why it names none.
 */
export type Named = Readonly<
	| { text: string; kind: "names"; ids: Arr.NonEmptyReadonlyArray<IncludedId> }
	| { text: string; kind: "unnamed"; why: string }
>

/** Every argument the property draws from: modules, a directory and identities, each naming properties or none. */
const roster: Arr.NonEmptyReadonlyArray<Named> = [
	{ text: "test/has.test.ts", kind: "names", ids: included },
	{ text: "test/", kind: "names", ids: included },
	{ text: "test/has", kind: "names", ids: included },
	{ text: "test/has.test.ts#one", kind: "names", ids: ["test/has.test.ts#one"] },
	{
		text: "test/has.test.ts#pair",
		kind: "names",
		ids: ["test/has.test.ts#pair/a", "test/has.test.ts#pair/b"]
	},
	{ text: "test/has.test.ts#pair/b", kind: "names", ids: ["test/has.test.ts#pair/b"] },
	{
		text: "test/has.test.ts#two",
		kind: "unnamed",
		why: "test/has.test.ts exports no property two"
	},
	{
		text: "test/has.test.ts#pair/c",
		kind: "unnamed",
		why: "test/has.test.ts exports no property pair/c"
	},
	{ text: "test/none.test.ts", kind: "unnamed", why: "test/none.test.ts exports no property" },
	{
		text: "test/none.test.ts#one",
		kind: "unnamed",
		why: "test/none.test.ts exports no property one"
	},
	{
		text: "other/outside.test.ts",
		kind: "unnamed",
		why: "other/outside.test.ts is not in the runner config's include"
	},
	{
		text: "other/outside.test.ts#one",
		kind: "unnamed",
		why: "other/outside.test.ts#one is not in the runner config's include"
	},
	{
		text: "test/gone.test.ts",
		kind: "unnamed",
		why: "test/gone.test.ts is not in the runner config's include"
	}
]

/** A command's arguments: none, or up to three of the roster's, in its order. */
export const selections = subset(roster, { min: 0, max: 3 })

/** What a load of the scratch package must give back: the properties named, in discovery order, or the refusal. */
export type Loaded =
	| Readonly<{ kind: "loaded"; ids: ReadonlyArray<string> }>
	| Readonly<{ kind: "refused"; path: string; message: string }>

/**
 * What loading the scratch package with `selection` must give back, by the specification: every included property for
 * no argument; else, when an argument names none, the refusal naming each such argument and why, in argument order;
 * else the included properties any argument names, in discovery order.
 */
export const expectedOf = (selection: ReadonlyArray<Named>): Loaded => {
	const unnamed = Arr.flatMap(selection, (named) => (named.kind === "unnamed" ? [named] : []))
	return Arr.isReadonlyArrayNonEmpty(unnamed)
		? {
				kind: "refused",
				path: Arr.join(
					Arr.map(unnamed, (named) => named.text),
					" "
				),
				message: `no property is named by ${Arr.join(
					Arr.map(unnamed, (named) => named.why),
					"; "
				)}`
			}
		: {
				kind: "loaded",
				ids: Arr.isReadonlyArrayNonEmpty(selection)
					? Arr.filter(included, (id) =>
							Arr.some(selection, (named) => named.kind === "names" && Arr.contains(named.ids, id))
						)
					: included
			}
}

/** A load as the check compares it: the ids it discovered, or its refusal's path and message. */
export const loadedOf = (result: Result.Result<ReadonlyArray<Discovered>, LoadFailed>): Loaded =>
	Result.match(result, {
		onSuccess: (discovered): Loaded => ({
			kind: "loaded",
			ids: Arr.map(discovered, (found) => found.id)
		}),
		onFailure: (failed): Loaded => ({ kind: "refused", path: failed.path, message: failed.message })
	})

/** A test module's text exporting `exports`, each a property of the library's (the file URLs this module resolves). */
const moduleOf = (exports: ReadonlyArray<string>): string =>
	Arr.join(
		[
			`import { Effect } from "${import.meta.resolve("effect")}"`,
			`import { int } from "${import.meta.resolve("#gen.ts")}"`,
			`import { family, property } from "${import.meta.resolve("#property.ts")}"`,
			`const spec = { needs: {}, situations: [], check: () => () => Effect.void, oracle: { kind: "specification", name: "never run" }, kept: [], kills: [] }`,
			...exports,
			""
		],
		"\n"
	)

/**
 * Writes the scratch package into `directory`. Each import is the file URL this module resolves (a file URL holds no
 * quote), so the package's config and modules load the classes the case's loadPackage tells them by.
 */
export const writtenPackage = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.makeDirectory(`${directory}/test`, { recursive: true })
		yield* fs.makeDirectory(`${directory}/other`, { recursive: true })
		yield* fs.writeFileString(
			`${directory}/test.config.ts`,
			Arr.join(
				[
					`import { Layer } from "${import.meta.resolve("effect")}"`,
					`import { defineRunner, noMutation } from "${import.meta.resolve("#runner/config.ts")}"`,
					`export default defineRunner({ budget: { kind: "cpu", run: ${String(UNRUN_BUDGET)}, import: ${String(UNRUN_BUDGET)} }, include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: [], layer: Layer.empty, mutation: noMutation })`,
					""
				],
				"\n"
			)
		)
		yield* fs.writeFileString(
			`${directory}/test/has.test.ts`,
			moduleOf([
				"export const one = property.explore(int(0, 9), spec)",
				"export const pair = family({ a: property.explore(int(0, 9), spec), b: property.explore(int(0, 9), spec) })"
			])
		)
		yield* fs.writeFileString(`${directory}/test/none.test.ts`, "export {}\n")
		yield* fs.writeFileString(
			`${directory}/other/outside.test.ts`,
			moduleOf(["export const one = property.explore(int(0, 9), spec)"])
		)
	})

/** What a drawn selection reaches, each a note of the property's. */
export type Situation =
	| "no argument, every property"
	| "every argument names a property"
	| "an argument not in the include"
	| "an included module exporting no property"
	| "an identity its module does not export"
	| "an argument naming none beside one naming some"

/** The situations `selection` reaches. */
export const situationsOf = (selection: ReadonlyArray<Named>): ReadonlyArray<Situation> => {
	const unnamed = Arr.filter(selection, (named) => named.kind === "unnamed")
	const reached: ReadonlyArray<readonly [Situation, boolean]> = [
		["no argument, every property", selection.length === 0],
		["every argument names a property", selection.length > 0 && unnamed.length === 0],
		[
			"an argument not in the include",
			Arr.some(unnamed, (named) => Str.endsWith("is not in the runner config's include")(named.why))
		],
		[
			"an included module exporting no property",
			Arr.some(selection, (named) => named.text === "test/none.test.ts")
		],
		[
			"an identity its module does not export",
			Arr.some(
				unnamed,
				(named) => Str.startsWith("test/")(named.text) && Str.includes("#")(named.text)
			)
		],
		[
			"an argument naming none beside one naming some",
			unnamed.length > 0 && unnamed.length < selection.length
		]
	]
	return Arr.flatMap(reached, ([situation, holds]) => (holds ? [situation] : []))
}
