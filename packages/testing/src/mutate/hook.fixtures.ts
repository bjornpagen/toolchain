import { Array as Arr, String as Str } from "effect"

/** The ways a process reaches the mutant's file. */
export const WAYS = ["import", "require", "dynamic import", "through another module"] as const

export type Way = (typeof WAYS)[number]

/** A case: the target's own number and its mutant's, the ways main reaches it, its extension, and whether it is hooked. */
export type Hooked = Readonly<{
	own: number
	mutant: number
	ways: Arr.NonEmptyReadonlyArray<Way>
	extension: ".ts" | ".js"
	hooked: boolean
}>

/** A module exporting `value`, typed when it is TypeScript. */
export const valueModule = (extension: Hooked["extension"], value: number) =>
	extension === ".ts"
		? `export const value: number = ${String(value)}\n`
		: `export const value = ${String(value)}\n`

/** How main reads the target's value one way. */
const readOf = (way: Way, target: string): Readonly<{ head: string; read: string }> => {
	switch (way) {
		case "import":
			return { head: `import { value as viaImport } from "./${target}"`, read: "viaImport" }
		case "require":
			return { head: "", read: `require("./${target}").value` }
		case "dynamic import":
			return { head: "", read: `(await import("./${target}")).value` }
		case "through another module":
			return { head: `import { relayed } from "./relay.ts"`, read: "relayed" }
	}
}

/** Main: reads the target each of `ways`, and the untouched module, and prints every value on one line. */
export const mainOf = (ways: ReadonlyArray<Way>, target: string) => {
	const reads = Arr.map(ways, (way) => readOf(way, target))
	return Arr.join(
		[
			`import { createRequire } from "node:module"`,
			`import { value as untouched } from "./untouched.ts"`,
			...Arr.filter(
				Arr.map(reads, (r) => r.head),
				Str.isNonEmpty
			),
			"const require = createRequire(import.meta.url)",
			`console.log([untouched, ${Arr.join(
				Arr.map(reads, (r) => r.read),
				", "
			)}].join(" "))`
		],
		"\n"
	)
}
