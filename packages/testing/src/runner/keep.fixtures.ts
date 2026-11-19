import { Array as Arr, String as Str } from "effect"
import { array, codePoint, type Gen, int, map, oneOf } from "#gen.ts"

/**
 * A part of a drawn text, as keep.test.ts's spaces print it, each part closed by a bar so no two parts' digits run
 * together: an integer of `lo..hi` spelled before a `q` (the integer a string spells, which no length or character code
 * of the text pins), or a choice of two arms that print alike until a digit is drawn (`before` and a digit, or a
 * digit and `after`), whose simplest draws a target tells apart only by their completions.
 */
export type Part =
	| Readonly<{ kind: "spelled"; lo: number; hi: number }>
	| Readonly<{ kind: "arm"; before: string; after: string }>

/**
 * A spelled integer's range, wide past every character code the texts hold: above zero, where an int's decision is its
 * value less its range's least, the step between two draws; or around zero, where it is its value's place in the
 * near-zero order (2v - 1, or -2v), which only the value itself names; or a choice of two arms.
 */
const partGen: Gen<Part> = oneOf<Part>([
	(source) => {
		const lo = source.draw(int(0, 500))
		return { kind: "spelled", lo, hi: lo + source.draw(int(200, 5000)) }
	},
	(source) => {
		const reach = source.draw(int(200, 5000))
		return { kind: "spelled", lo: -reach, hi: reach }
	},
	(source) => ({
		kind: "arm",
		before: source.draw(codePoint(0x61, 0x7a)),
		after: source.draw(codePoint(0x61, 0x7a))
	})
])

/** A space's shape: one to four parts. */
export const shapes: Gen<Arr.NonEmptyReadonlyArray<Part>> = (source) => [
	source.draw(partGen),
	...source.draw(array(partGen, { min: 0, max: 3 }))
]

/** A part's own space (Part). */
const partSpace = (part: Part): Gen<string> => {
	switch (part.kind) {
		case "spelled":
			return map(int(part.lo, part.hi), (n) => `${n}q|`)
		case "arm":
			return oneOf([
				map(int(0, 9), (d) => `${part.before}${d}|`),
				map(int(0, 9), (d) => `${d}${part.after}|`)
			])
	}
}

/** The space of a shape's texts: its parts' texts in order. */
export const spaceOf =
	(parts: Arr.NonEmptyReadonlyArray<Part>): Gen<string> =>
	(source) =>
		Arr.join(
			Arr.map(parts, (part) => source.draw(partSpace(part))),
			""
		)

/** What a target text reached: a spelled integer past a digit's range, and an arm's second choice past its first digit. */
export type KeepFeature =
	| "an integer spelled past a digit"
	| "an arm only its completion tells apart"

/** The features a target text of `parts` reaches, read off its parts' texts. */
export const featuresOf = (
	parts: Arr.NonEmptyReadonlyArray<Part>,
	text: string
): ReadonlyArray<KeepFeature> =>
	Arr.flatMap(Arr.zip(parts, Str.split(text, "|")), ([part, piece]): ReadonlyArray<KeepFeature> => {
		switch (part.kind) {
			case "spelled":
				return Math.abs(Number(Str.slice(0, -1)(piece))) > 9
					? ["an integer spelled past a digit"]
					: []
			case "arm":
				return Str.startsWith(part.before)(piece) || Str.startsWith("0")(piece)
					? []
					: ["an arm only its completion tells apart"]
		}
	})
