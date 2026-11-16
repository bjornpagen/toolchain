import { Array as Arr } from "effect"
import { array, element, type Gen } from "#gen.ts"

/** Where a file lies against the checkout: the checkout itself, inside it, beside it with its name as a prefix, or apart. */
export const PLACES = ["the checkout", "inside", "a sibling sharing its prefix", "apart"] as const

export type Place = (typeof PLACES)[number]

/** A case: the checkout's path, a tree's root, and a file placed against the checkout, each a list of segments. */
export type Rebasing = Readonly<{
	checkout: Arr.NonEmptyReadonlyArray<string>
	root: Arr.NonEmptyReadonlyArray<string>
	place: Place
	rest: ReadonlyArray<string>
}>

const SEGMENTS = ["repo", "pkg", "src", "a.ts", "trees", "0", "node_modules"] as const

const segments: Gen<Arr.NonEmptyReadonlyArray<string>> = (source) =>
	Arr.prepend(
		source.draw(array(element(SEGMENTS), { min: 0, max: 2 })),
		source.draw(element(SEGMENTS))
	)

export const rebasingGen: Gen<Rebasing> = (source) => ({
	checkout: source.draw(segments),
	root: Arr.prepend(source.draw(segments), "tree-root"),
	place: source.draw(element(PLACES)),
	rest: source.draw(array(element(SEGMENTS), { min: 0, max: 3 }))
})

/** A path from its segments. */
export const pathOf = (parts: ReadonlyArray<string>) => `/${Arr.join(parts, "/")}`

/** The file a case places, as segments. */
export const fileOf = (rebasing: Rebasing): ReadonlyArray<string> => {
	switch (rebasing.place) {
		case "the checkout":
			return rebasing.checkout
		case "inside":
			return [...rebasing.checkout, "in", ...rebasing.rest]
		case "a sibling sharing its prefix":
			return [
				...Arr.initNonEmpty(rebasing.checkout),
				`${Arr.lastNonEmpty(rebasing.checkout)}x`,
				...rebasing.rest
			]
		case "apart":
			return ["elsewhere", ...rebasing.rest]
	}
}

/** Where the file stands for a tree's worker, by segments: under the root when the checkout's segments lead it. */
export const expectedOf = (rebasing: Rebasing): string => {
	const file = fileOf(rebasing)
	const leads =
		file.length >= rebasing.checkout.length &&
		Arr.every(rebasing.checkout, (part, index) => file[index] === part)
	return leads
		? pathOf([...rebasing.root, ...Arr.drop(file, rebasing.checkout.length)])
		: pathOf(file)
}
