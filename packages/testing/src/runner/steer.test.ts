/**
 * The steered phase (runner/search.ts), against what it promises:
 *
 * - It climbs, one new note at a time, to a situation random search never reaches: over drawn locks of five magic
 *   values of 0..31, which random search meets once in 33 million cases, a search with no steered budget leaves the
 *   lock's requirement unreached, and one whose steered budget is unbounded opens it, within the case deadline. A
 *   capability of the search, its verdict the specification's.
 * - It takes turns: over drawn searches (1 to 12 requirements, windows of 1 to 8 cases, floors of 1 to 8 cases, steered
 *   budgets of 0 to 40, cases that never or sometimes reach a requirement), each case aims at one requirement pending
 *   as its window began, the window's aims are distinct while it holds no more cases than are pending, and with k
 *   pending and windows of w every requirement still pending is aimed at within ⌈k / w⌉ windows of its stream. Oracle:
 *   the specification, judged on what each case's aim drew it for and on what the cases before its window reached.
 *
 * That the witnesses, floor and steered, are the property identity's alone, the same at every width and run seed, is
 * runner/search.test.ts's coverage verdict.
 */
import { Effect, Option } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { property } from "#property.ts"
import { fullRun, searchedAt, unreachedOf, verdictKind } from "#runner/search.fixtures.ts"
import {
	lockOf,
	magics,
	steeredBy,
	type TurnFeature,
	turnLimits,
	turnShapes,
	turnsKept,
	turnsOf,
	windowsOf
} from "#runner/steer.fixtures.ts"

export const climbs = property.explore(magics, {
	needs: {},
	situations: [],
	check: () => (magic) =>
		Effect.gen(function* () {
			const id = "lock/inner"
			const blind = yield* searchedAt(lockOf(magic), { ...fullRun(id, 0), limits: steeredBy(0) })
			const steered = yield* searchedAt(lockOf(magic), {
				...fullRun(id, 0),
				reach: "witnesses",
				limits: steeredBy(Number.POSITIVE_INFINITY)
			})
			deepStrictEqual(
				{ blind: unreachedOf(blind), steered: verdictKind(steered) },
				{ blind: Option.some(["5 matched"]), steered: "explored" }
			)
		}),
	oracle: {
		kind: "specification",
		name: "a steered search climbs one new note at a time to a lock random search never opens"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/search.ts",
			original: "between(counted.words, 0, FRESH_EVERY - 1) === 0",
			replacement: "between(counted.words, 0, FRESH_EVERY - 1) >= 0",
			why: "Every steered case is a fresh draw, never a mutant of a seed (steer-fresh-only, re-anchored from explore.ts to the new search's steered phase), so the steered search no longer climbs; the climb property fails, red by its own case deadline."
		}
	]
})

export const turns = property.explore(turnShapes, {
	needs: {},
	situations: [
		"more pending than a window holds",
		"a window holding more cases than are pending",
		"a requirement reached between windows",
		"a steered phase of several windows"
	],
	check: (_resources, c) => (shape) =>
		Effect.gen(function* () {
			const inner = turnsOf(shape)
			yield* searchedAt(inner.property, {
				...fullRun("turns/inner", 0),
				reach: "witnesses",
				limits: turnLimits(shape)
			})
			const floor = windowsOf(
				inner.seen.slice(0, shape.floor),
				shape.window,
				shape.pending,
				new Set()
			)
			const steered = windowsOf(
				inner.seen.slice(shape.floor),
				shape.window,
				shape.pending,
				floor.reached
			)
			const several: ReadonlyArray<TurnFeature> =
				steered.windows.length > 1 ? ["a steered phase of several windows"] : []
			c.noteAll([
				...turnsKept(floor.windows, shape.window),
				...turnsKept(steered.windows, shape.window),
				...several
			])
		}),
	oracle: {
		kind: "specification",
		name: "a window's cases aim at distinct pending requirements, every one within ⌈pending / window⌉ windows"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/features.ts",
			original: "\t\t\treturn (offset) => turnOf(pending, after, offset)",
			replacement: "\t\t\treturn () => pending",
			why: "Every case of a window aimed at the first pending requirement; the third property, the turns, fails."
		},
		{
			file: "packages/testing/src/features.ts",
			original:
				"\t\t\tif (cases > 0) {\n\t\t\t\tlast = Option.getOrElse(Arr.head(turnOf(pending, after, cases - 1)), () => after)\n\t\t\t}\n",
			replacement: "",
			why: "Each window's i-th case aimed at the i-th pending requirement, its stream's last aim forgotten; the third property, the turns, fails."
		}
	]
})
