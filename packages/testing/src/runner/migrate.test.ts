/**
 * A kept token written before a weighted decision recorded its option (toolchain 71eb30f) migrates to the token of the
 * same case as a case records it now (source.ts translatedChooser, runner/search.ts translate, `toolchain-test kept
 * migrate`): a weighted decision's old value, a unit of its total, reads as the option that owns it, every other value
 * as it is, and the case drawn on the old values read so is the case the new values draw again. A pick among commands
 * read its unit over their weights' greatest common divisor, and a migration reads it so. A unit past the total, or a
 * token whose case does not run exactly its values, is left as it is. Oracle: the specification, each option owning the
 * next `weight` units of the total, in order, as a weighted pick read its unit before 71eb30f.
 */
import { Array as Arr, Effect } from "effect"
import { assert } from "#assert.ts"
import { finite } from "#gen.ts"
import { property } from "#property.ts"
import { replayTokenOf } from "#replay.ts"
import {
	commandUnits,
	dividedOf,
	oneStepOf,
	optionsOf,
	overOneOption,
	overOptions,
	ownerOf,
	PLANTED_WEIGHTS,
	translatedDraw,
	units
} from "#runner/migrate.fixtures.ts"
import { fullRun, replayedAt, translatedAt, verdictKind } from "#runner/search.fixtures.ts"

export const unitsTakeTheirOptions = property.exhaust(finite(units), {
	box: "options of two or three weights and every unit of their total, and the one past it",
	needs: {},
	situations: [],
	check: () => (drawn) =>
		Effect.sync(() => {
			const owner = ownerOf(drawn.weights, drawn.unit)
			const translated = translatedDraw(optionsOf(drawn.weights), drawn.unit)
			assert.deepEqual(
				owner === "none"
					? { status: translated.status }
					: { value: translated.value, status: translated.status, again: translated.again },
				owner === "none"
					? { status: "overrun" }
					: { value: owner, status: "complete", again: owner }
			)
		}),
	oracle: {
		kind: "specification",
		name: "a weighted decision's old unit reads as the option that owns it, the new tape drawing that option again; a unit past the total is no value of the decision"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: '\t\tif (spread.kind !== "weighted") {\n',
			replacement: '\t\tif (spread.kind !== "weighted" || true) {\n',
			why: "Every old value is taken as it is, a weighted one's unit as an option's index, so a unit past an option's first names a later option, or none; the property fails."
		},
		{
			file: "packages/testing/src/source.ts",
			original:
				"\t\treturn unit >= 0 && unit < spread.total ? lo + optionAt(spread, unit) : lo - 1\n",
			replacement: "\t\treturn lo + optionAt(spread, unit)\n",
			why: "A unit past the total reads as the last option, so a token that names no case of the property migrates to one that does; the property fails."
		}
	]
})

export const commandUnitsOverTheirDivisor = property.exhaust(finite(commandUnits), {
	box: "commands of weights sharing a divisor and every unit of their divided total, a program of one step",
	needs: {},
	situations: [],
	check: () => (drawn) =>
		Effect.sync(() => {
			const translated = translatedDraw(oneStepOf(drawn.weights), drawn.unit)
			const command = `c${ownerOf(dividedOf(drawn.weights), drawn.unit)}`
			assert.deepEqual(
				{
					commands: Arr.map(translated.value, (step) => step.command),
					again: Arr.map(translated.again, (step) => step.command)
				},
				{ commands: [command], again: [command] }
			)
		}),
	oracle: {
		kind: "specification",
		name: "a pick among commands read its unit over their weights' greatest common divisor, and its migration reads it so"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/commands.ts",
			original: "\t\tsource.weigh(weightsOf(Arr.map(weighted, ([, weight]) => weight / common)))\n",
			replacement: "\t\tsource.weigh(weightsOf(Arr.map(weighted, ([, weight]) => weight)))\n",
			why: "A pick weighs its commands undivided, so an old unit, a unit of the divided total, reads against the whole weights and names an earlier command; the property fails."
		}
	]
})

export const keptTokensMigrate = property.exhaust(finite(units), {
	box: "a planted property's tokens of one old value, every unit of its options' total and the one past it, and a token of one option of weight five",
	needs: {},
	situations: [],
	check: () => (drawn) =>
		Effect.gen(function* () {
			const id = "kept migrate/inner"
			const run = fullRun(id, 1)
			const old = replayTokenOf(id, { drawn: { kind: "unsteered" }, values: [drawn.unit] })
			const owner = ownerOf(PLANTED_WEIGHTS, drawn.unit)
			const translation = yield* translatedAt(overOptions, run, old)
			const replayed =
				translation.kind === "translated"
					? yield* Effect.map(
							replayedAt(overOptions, run, replayTokenOf(id, translation.replayed)),
							verdictKind
						)
					: "untranslated"
			const lone = yield* translatedAt(overOneOption, run, old)
			assert.deepEqual(
				{
					values: translation.kind === "translated" ? translation.replayed.values : "untranslated",
					replayed,
					lone: lone.kind
				},
				{
					values: owner === "none" ? "untranslated" : [owner],
					replayed: owner === "none" ? "untranslated" : "replayed",
					lone: "untranslated"
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "a kept token's case run on its old values read as they were meant migrates to the token of the option that owns its unit, which replays; a unit past the total, or a token of a weighted decision of one option, whose old unit no decision reads now, is left"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/search.ts",
			original:
				'\t\t\t\t\t\t\t\t\tchooser: { kind: "translated", values: Float64Array.from(replayed.values) },\n',
			replacement:
				'\t\t\t\t\t\t\t\t\tchooser: { kind: "forced", values: Float64Array.from(replayed.values) },\n',
			why: "A token's migration runs its case on its old values as they are, so its weighted decision's unit stays an option's index, a later option or none; the property fails."
		},
		{
			file: "packages/testing/src/runner/search.ts",
			original: "\t\t\t\t\t\t\t\tranExactly(result, replayed.values.length)\n",
			replacement: "\t\t\t\t\t\t\t\ttrue\n",
			why: "A migration keeps whatever its case recorded, though the case ran other than exactly the token's values, so a token of one weighted option of weight five migrates to an empty token of another case; the property fails."
		}
	]
})
