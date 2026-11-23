import { Array as Arr, String as Str } from "effect"
import { array, boolean, element, type Gen } from "#gen.ts"
import { PropertyId } from "#property.ts"
import type { Touched } from "#runner/affected.ts"

/** The files a landing's properties are drawn over: two of the repository's own, one inside a submodule. */
const FILES = ["src/a.ts", "src/b.ts", "vendor/lib/x.ts"] as const

/** What a landing may change: a file, the lockfile, or a submodule's gitlink, which stands for every file below it. */
const CHANGES = ["src/a.ts", "src/b.ts", "pnpm-lock.yaml", "vendor/lib"] as const

/** A landing: what it changed, and its properties as the gate weighs them. */
export type Landing = Readonly<{
	changed: ReadonlyArray<string>
	properties: ReadonlyArray<Touched>
}>

const touchedGen =
	(index: number): Gen<Touched> =>
	(source) => ({
		id: PropertyId(`test/p.test.ts#p${String(index)}`),
		files: Arr.dedupe(source.draw(array(element(FILES), { min: 0, max: 3 }))),
		packages: source.draw(boolean),
		passed: source.draw(boolean)
	})

export const landingGen: Gen<Landing> = (source) => ({
	changed: Arr.dedupe(source.draw(array(element(CHANGES), { min: 0, max: 3 }))),
	properties: Array.from({ length: source.draw(element([1, 2, 3])) }, (_, index) =>
		source.draw(touchedGen(index))
	)
})

/** Whether `file` is changed by a landing that changed `changed`: it is, or a directory above it (a gitlink) is. */
const changedFile = (changed: ReadonlyArray<string>, file: string): boolean =>
	Arr.some(changed, (path) => path === file || Str.startsWith(`${path}/`)(file))

/**
 * What the gate must refuse of a landing, by the specification: each property a changed file of its closure or a
 * changed lockfile it reads touches, and whose key holds no pass.
 */
export const refusedOf = (landing: Landing): ReadonlyArray<PropertyId> =>
	Arr.flatMap(landing.properties, (one) =>
		(Arr.some(one.files, (file) => changedFile(landing.changed, file)) ||
			(one.packages && Arr.contains(landing.changed, "pnpm-lock.yaml"))) &&
		!one.passed
			? [one.id]
			: []
	)

/** What a landing reaches. */
export type LandingSituation =
	| "a touched property refused"
	| "a touched property carrying its verdict"
	| "touched through the lockfile alone"
	| "touched below a gitlink"
	| "an untouched property"

/** The situations a landing reaches. */
export const landingSituationsOf = (landing: Landing): ReadonlyArray<LandingSituation> =>
	Arr.flatMap(landing.properties, (one): ReadonlyArray<LandingSituation> => {
		const byFile = Arr.some(one.files, (file) => changedFile(landing.changed, file))
		const byLock = one.packages && Arr.contains(landing.changed, "pnpm-lock.yaml")
		const belowLink = Arr.some(one.files, (file) =>
			Arr.some(landing.changed, (path) => Str.startsWith(`${path}/`)(file))
		)
		const touched = byFile || byLock
		return [
			...(touched
				? [
						one.passed
							? ("a touched property carrying its verdict" as const)
							: ("a touched property refused" as const)
					]
				: ["an untouched property" as const]),
			...(byLock && !byFile ? ["touched through the lockfile alone" as const] : []),
			...(belowLink ? ["touched below a gitlink" as const] : [])
		]
	})
