import { Array as Arr } from "effect"
import { boolean, element, type Gen, int } from "#gen.ts"

/** How a file reads its parent: through a value import, or through `import type` alone. */
const EDGES = ["value", "type"] as const

export type Edge = (typeof EDGES)[number]

/**
 * What the mutant of f0 changes:
 *
 * - declaration: `n` becomes a string, so its type, f0's surface, changes, and a file that uses `N` as a number no
 *   longer typechecks;
 * - body: the body of `k`, whose return type is annotated, becomes a string, a type error in f0 alone, its surface
 *   kept;
 * - value: the body of `k` becomes another number, no type error anywhere, its surface kept.
 */
const MUTATIONS = ["declaration", "body", "value"] as const

export type Mutation = (typeof MUTATIONS)[number]

/**
 * A package of files: f0 exports a number `n`, its type `N` and a function `k` whose return type is annotated; each
 * later file reads its parent's `n` and `N` through a value import or a type import and exports its own; a stranger
 * reads nothing. One file (or the stranger) uses `N` as a number, and holds a type error of its own, unmutated, when it
 * is `broken`. The mutant of f0 changes what `mutation` says.
 */
export type Package = Readonly<{
	parents: ReadonlyArray<Readonly<{ parent: number; edge: Edge }>>
	user: number
	broken: boolean
	mutation: Mutation
}>

export const packageGen: Gen<Package> = (source) => {
	const files = source.draw(int(1, 4))
	const parents = Array.from({ length: files - 1 }, (_, index) => ({
		parent: source.draw(int(0, index)),
		edge: source.draw(element(EDGES))
	}))
	const stranger = source.draw(boolean)
	return {
		parents,
		user: stranger ? -1 : source.draw(int(0, files - 1)),
		broken: source.draw(boolean),
		mutation: source.draw(element(MUTATIONS))
	}
}

/** The use of `N` as a number, and the user's own type error when the package is broken. */
const useOf = (pkg: Package) =>
	`export const used = (x: N): number => x\n${pkg.broken ? "export const broken: string = 1\n" : ""}`

/** f0's text with `n` and `k`'s body as given, and the use when f0 is the user. */
const rootOf = (pkg: Package, n: string, k: string) =>
	`export const n = ${n}\nexport type N = typeof n\nexport const k = (): number => ${k}\n${pkg.user === 0 ? useOf(pkg) : ""}`

/** f0's own text. */
const rootText = (pkg: Package) => rootOf(pkg, "1", "1")

/** f0's text with the package's mutation applied. */
export const mutantText = (pkg: Package) => {
	switch (pkg.mutation) {
		case "declaration":
			return rootOf(pkg, '"one"', "1")
		case "body":
			return rootOf(pkg, "1", '"one"')
		case "value":
			return rootOf(pkg, "1", "2")
	}
}

/** The text of each file of the package, by its name, and the stranger's. */
export const filesOf = (pkg: Package): ReadonlyArray<readonly [string, string]> => {
	const later = Arr.map(pkg.parents, ({ parent, edge }, index): readonly [string, string] => {
		const body =
			edge === "value"
				? `import { n as m } from "./f${String(parent)}.ts"\nexport const n = m\nexport type N = typeof n\n`
				: `import type { N as M } from "./f${String(parent)}.ts"\nexport type N = M\nexport const n = 0 as unknown as N\n`
		return [`f${String(index + 1)}.ts`, pkg.user === index + 1 ? `${body}${useOf(pkg)}` : body]
	})
	return [
		["f0.ts", rootText(pkg)],
		...later,
		["stranger.ts", `export type N = number\n${pkg.user === -1 ? useOf(pkg) : ""}`]
	]
}

/** The path from f0 to the user, by the edges it crosses: none for the stranger. */
export const edgesTo = (pkg: Package): ReadonlyArray<Edge> => {
	const edges: Array<Edge> = []
	for (let at = pkg.user; at > 0;) {
		const { parent, edge } = Arr.getUnsafe(pkg.parents, at - 1)
		edges.push(edge)
		at = parent
	}
	return edges
}

/**
 * What typing the mutant must answer: refused when a file its verdict reads holds a type error unmutated (f0 always;
 * the user when the mutant changes f0's surface and the user reads f0), else invalid exactly when the mutant puts a type
 * error in a file that reads it.
 */
export type Expected =
	| Readonly<{ kind: "refused" }>
	| Readonly<{ kind: "judged"; invalid: boolean }>

export const expectedOf = (pkg: Package): Expected => {
	const reads = pkg.user !== -1
	if (pkg.broken && (pkg.user === 0 || (pkg.mutation === "declaration" && reads))) {
		return { kind: "refused" }
	}
	switch (pkg.mutation) {
		case "declaration":
			return { kind: "judged", invalid: reads }
		case "body":
			return { kind: "judged", invalid: true }
		case "value":
			return { kind: "judged", invalid: false }
	}
}
