import { Array as Arr } from "effect"
import { boolean, element, type Gen, int } from "#gen.ts"

/** How a file reads its parent: through a value import, or through `import type` alone. */
const EDGES = ["value", "type"] as const

export type Edge = (typeof EDGES)[number]

/**
 * A package of files: f0 exports a number `n` and its type `N`; each later file reads its parent's `n` and `N` through
 * a value import or a type import and exports its own; a stranger reads nothing. One file (or the stranger) uses `N`
 * as a number, which a mutant of f0 that makes `n` a string turns into a type error, in the user's file alone.
 */
export type Package = Readonly<{
	parents: ReadonlyArray<Readonly<{ parent: number; edge: Edge }>>
	user: number
}>

export const packageGen: Gen<Package> = (source) => {
	const files = source.draw(int(1, 4))
	const parents = Array.from({ length: files - 1 }, (_, index) => ({
		parent: source.draw(int(0, index)),
		edge: source.draw(element(EDGES))
	}))
	const stranger = source.draw(boolean)
	return { parents, user: stranger ? -1 : source.draw(int(0, files - 1)) }
}

/** f0's text, with `n` the number it is or the string a mutant makes it, and the use when f0 is the user. */
export const rootText = (pkg: Package, value: string) =>
	`export const n = ${value}\nexport type N = typeof n\n${pkg.user === 0 ? USE : ""}`

/** The use of `N` as a number. */
const USE = "export const used = (x: N): number => x\n"

/** The text of each file of the package, by its name, and the stranger's. */
export const filesOf = (pkg: Package): ReadonlyArray<readonly [string, string]> => {
	const later = Arr.map(pkg.parents, ({ parent, edge }, index): readonly [string, string] => {
		const body =
			edge === "value"
				? `import { n as m } from "./f${String(parent)}.ts"\nexport const n = m\nexport type N = typeof n\n`
				: `import type { N as M } from "./f${String(parent)}.ts"\nexport type N = M\nexport const n = 0 as unknown as N\n`
		return [`f${String(index + 1)}.ts`, pkg.user === index + 1 ? `${body}${USE}` : body]
	})
	return [
		["f0.ts", rootText(pkg, "1")],
		...later,
		["stranger.ts", `export type N = number\n${pkg.user === -1 ? USE : ""}`]
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
