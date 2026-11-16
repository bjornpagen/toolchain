import { Array as Arr, Brand } from "effect"
import type { Gen } from "#gen.ts"

/**
 * A closed vocabulary, whose items are the domain itself (a language's keywords, an alphabet a grammar fixes), never
 * cases a person chose: a pick from one is a Space, where a pick from a literal list is a CaseList. Only this door
 * mints one (`dictionary`), and the import-doors rule names the modules that may import it.
 */
export type Dictionary<A> = Arr.NonEmptyReadonlyArray<A> & Brand.Brand<"Dictionary">

/** A vocabulary as a Dictionary: the one mint, in the door the import-doors rule guards. */
export const dictionary = <const A>(items: Arr.NonEmptyReadonlyArray<A>): Dictionary<A> =>
	Brand.nominal<Dictionary<A>>()(items)

/** One item of a dictionary, shrinking toward its first: a plain generator, so a Space. */
export const word =
	<A>(vocabulary: Dictionary<A>): Gen<A> =>
	(source) =>
		Arr.getUnsafe(vocabulary, source.pick(0, vocabulary.length - 1))
