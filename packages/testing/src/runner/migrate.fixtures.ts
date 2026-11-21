import { Array as Arr, Effect, Record as Rec } from "effect"
import { accepted, type Machine, program } from "#commands.ts"
import { constant, element, type Gen, int, type Weight, type Weighted, weighted } from "#gen.ts"
import { property } from "#property.ts"
import { forcedChooser, generate, recorder, translatedChooser } from "#source.ts"
import { fullSwarm } from "#swarm.ts"

/**
 * What the migration properties of kept tokens written before a weighted decision recorded its option (migrate.test.ts)
 * draw and run: options of a few weights, each drawn as its index, and a unit of their total, or the one past it; state
 * machines of commands whose weights share a divisor; and a planted property over weighted options, whose kept tokens
 * a run migrates.
 */

/** The weights of the drawn options, in their order: two or three options, the first never the heaviest alone. */
const OPTION_WEIGHTS = [
	[1, 1],
	[2, 1],
	[1, 3],
	[3, 2, 1],
	[2, 2, 5]
] as const satisfies ReadonlyArray<Arr.NonEmptyReadonlyArray<Weight>>

/** Options of these weights, each drawn as its index. */
export const optionsOf = (weights: Arr.NonEmptyReadonlyArray<Weight>): Gen<number> =>
	weighted(Arr.map(weights, (weight, index): Weighted<number> => [weight, constant(index)]))

/** The sum of the weights. */
const totalOf = (weights: ReadonlyArray<number>): number =>
	Arr.reduce(weights, 0, (sum, weight) => sum + weight)

/**
 * The option that owns a unit of the weights' total, as a weighted pick read its unit before 71eb30f: each option owns
 * the next `weight` units, in order; none past the total.
 */
export const ownerOf = (weights: ReadonlyArray<number>, unit: number): number | "none" => {
	const below = Arr.findFirstIndex(
		Arr.map(weights, (_, index) => totalOf(Arr.take(weights, index + 1))),
		(through) => unit < through
	)
	return below._tag === "Some" ? below.value : "none"
}

/** A drawn translation: options' weights, and a unit of their total or the one past it. */
type Units = Readonly<{ weights: Arr.NonEmptyReadonlyArray<Weight>; unit: number }>

/** Every option weights' every unit, and the one past the total. */
export const units: Gen<Units> = (source) => {
	const weights = source.draw(element(OPTION_WEIGHTS))
	return { weights, unit: source.draw(int(0, totalOf(weights))) }
}

/**
 * `space` drawn on one old value read as it was meant (source.ts translatedChooser): the value, whether the draw ran
 * within its decisions, and the value its new tape draws again, exactly (forcedChooser).
 */
export const translatedDraw = <A>(space: Gen<A>, unit: number) => {
	const translated = generate(recorder(), space, translatedChooser(Float64Array.of(unit), 1))
	const again = generate(
		recorder(),
		space,
		forcedChooser(translated.tape.values, translated.tape.length)
	)
	return { value: translated.value, status: translated.tape.status, again: again.value }
}

/** Commands' weights that share a divisor, and the units of their divided total. */
const COMMAND_WEIGHTS = [
	[2, 4],
	[3, 6, 9],
	[4, 4, 8]
] as const satisfies ReadonlyArray<Arr.NonEmptyReadonlyArray<Weight>>

/** A machine of commands of these weights, named by their index, each taking no parameter and always applying. */
const machineOf = (
	weights: Arr.NonEmptyReadonlyArray<Weight>
): Machine<null, Record<string, undefined>, never> => ({
	initial: null,
	commands: Rec.fromEntries(
		Arr.map(weights, (weight, index) => [
			`c${index}`,
			{
				weight,
				applies: () => true,
				parameters: () => constant(undefined),
				judge: () => accepted(null)
			}
		])
	)
})

/** A drawn program's translation: commands' weights, and a unit of their total over its divisor. */
type CommandUnits = Readonly<{ weights: Arr.NonEmptyReadonlyArray<Weight>; unit: number }>

/** The divided weights of commands, as a pick before 71eb30f took them: each over their greatest common divisor. */
export const dividedOf = (weights: ReadonlyArray<number>): ReadonlyArray<number> => {
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
	const divisor = Arr.reduce(weights, 0, (common, weight) => gcd(weight, common))
	return Arr.map(weights, (weight) => weight / divisor)
}

/** Every commands' weights' every unit of their divided total. */
export const commandUnits: Gen<CommandUnits> = (source) => {
	const weights = source.draw(element(COMMAND_WEIGHTS))
	return { weights, unit: source.draw(int(0, totalOf(dividedOf(weights)) - 1)) }
}

/** A program of one step over a machine of these commands, whose every command applies (commands.ts program). */
export const oneStepOf = (weights: Arr.NonEmptyReadonlyArray<Weight>) => {
	const machine = machineOf(weights)
	return program(machine, { min: 1, max: 1 }, fullSwarm(Rec.keys(machine.commands)))
}

/** The planted property's options' weights: three options, whose second's units start past the first's two. */
export const PLANTED_WEIGHTS = [2, 1, 3] as const satisfies Arr.NonEmptyReadonlyArray<Weight>

/** A property planted over weighted options, each drawn as its index, whose every case passes. */
export const overOptions = property.explore(optionsOf(PLANTED_WEIGHTS), {
	needs: {},
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted over weighted options" },
	kept: [],
	kills: []
})

/** A property planted over one option of weight 5, which a weighted decision of one option draws, whose every case passes. */
export const overOneOption = property.explore(optionsOf([5]), {
	needs: {},
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted over one weighted option" },
	kept: [],
	kills: []
})
