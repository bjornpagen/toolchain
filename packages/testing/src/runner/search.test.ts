/**
 * The runner's searches (runner/search.ts), each held to what it promises over inner searches run in this process on
 * an evaluator that judges as many batches at once as a drawn width (search.fixtures.ts), so every property below
 * holds at every width a pool may have:
 *
 * - Streams: over drawn limits (rotating runs of 0 to 48, floors of 1 to 12, windows of 1 to 16), the floor runs its
 *   limit's cases and the rotating stream its runs, the residual counting the rotating cases alone.
 * - A property's own budget replaces the runner's: its rotating stream runs its `runs`, its floor a quarter of them
 *   rounded up, and its steered phase stops at its `steered`.
 * - Shrinking: a property failing at every draw of at least a drawn threshold shrinks to the threshold, its own draw
 *   edited with the case.
 * - Tokens: a replayed token that no longer runs as it says (steered by a requirement the property does not declare,
 *   its draws left over, or run out) is stale, never passed; a kept token's case is never a witness, so a situation only
 *   it reaches stays unreached; a kept case that fails prints its property's draws; a kept token whose draws run out or
 *   are left over is stale, never filled in; and what the system decided is recorded without counting as a draw.
 * - Steering: an aim draws a case only while its situation is pending when the case's window begins, in the floor's
 *   and steered phase's windows alone; a kept case is drawn by nothing, and a rotating case is drawn unsteered, as its
 *   token says.
 * - Exhaustion: over drawn spaces (a × b values, a property drawing one of c more), every case runs once at any width,
 *   and a space too large to count within the case deadline fails as uncountable with no case run; at any width it
 *   finds exactly what it finds at one: the same count, or the same first failing case.
 * - The coverage verdict is a function of the property's identity: two run seeds at two widths give the same verdict
 *   and the same witnesses, and the floor stream decides it where its cases already reach what is required.
 * - An aimed case is the case that ran: the one its failure prints, its token replays, and its kept token runs again.
 * - Replay fidelity: every failure replays alone from its token as the same case under the same steering, is found at
 *   any width, a witness's on every run seed, and its token kept fails as kept.
 *
 * Oracles are stated per property.
 */
import { Array as Arr, Effect, Option } from "effect"
import { deepStrictEqual, strictEqual } from "#assert.ts"
import { boolean, characterOf, int, string } from "#gen.ts"
import { type Case, property, ReplayToken } from "#property.ts"
import { replayTokenOf } from "#replay.ts"
import { runnerLimits } from "#runner/limits.ts"
import type { CasePhase } from "#runner/protocol.ts"
import {
	aimedSearch,
	aimedSketches,
	aimRecorder,
	caseOf,
	copiesOf,
	drawsFrom,
	drawsOnce,
	endless,
	failsAfter,
	fidelityRun,
	fidelitySearch,
	fidelitySketches,
	falsifiedOf,
	findingOf,
	floorDecides,
	fullRun,
	keptOf,
	observing,
	pairsOf,
	passing,
	rareByDraw,
	rareDraw,
	replayedAt,
	searchedAt,
	printedNumber,
	seeds,
	shownOf,
	type SpaceShape,
	staleOf,
	STALE_KINDS,
	staleCases,
	sketchExhaustion,
	tokenDrawn,
	tokenValues,
	unreachedOf,
	verdictKind,
	verdictSketches,
	widths,
	widthSketches,
	witnessLimits,
	witnessRun
} from "#runner/search.fixtures.ts"

/** A drawn inner search's limits and run: its rotating cases, floor, window, width and run seed. */
type StreamShape = Readonly<{
	runs: number
	floor: number
	window: number
	width: number
	seed: number
}>

export const streams = property.explore(
	(source): StreamShape => ({
		runs: source.draw(int(0, 48)),
		floor: source.draw(int(1, 12)),
		window: source.draw(int(1, 16)),
		width: source.draw(widths),
		seed: source.draw(seeds)
	}),
	{
		needs: {},
		situations: ["no rotating case", "several rotating windows", "a floor of several windows"],
		check: (_resources, c) => (shape) =>
			Effect.gen(function* () {
				if (shape.runs === 0) {
					c.note("no rotating case")
				}
				if (shape.runs > shape.window) {
					c.note("several rotating windows")
				}
				if (shape.floor > shape.window) {
					c.note("a floor of several windows")
				}
				const verdict = yield* searchedAt(passing, {
					id: "streams/inner",
					seed: shape.seed,
					reach: "full",
					limits: {
						runs: shape.runs,
						floor: shape.floor,
						steered: 0,
						window: shape.window,
						deadline: runnerLimits.deadline,
						open: runnerLimits.open
					},
					width: shape.width
				})
				deepStrictEqual(
					verdict.kind === "explored"
						? Option.some({
								cases: verdict.cases,
								floor: verdict.floor,
								steered: verdict.steered,
								independent: verdict.residual.cases
							})
						: Option.none(),
					Option.some({
						cases: shape.floor + shape.runs,
						floor: shape.floor,
						steered: 0,
						independent: shape.runs
					})
				)
			}),
		oracle: {
			kind: "specification",
			name: "the floor runs its limit's cases and the rotating stream its runs, which alone the residual counts"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/search.ts",
				original: "\t\t\t\tconst indices = indicesOf(start, window, floorCases)",
				replacement: "\t\t\t\tconst indices = indicesOf(start, window, floorCases - 1)",
				why: "The floor stream runs one case fewer than its limit (explore-floor-rounded-down, re-anchored from explore.ts's floor count to the new search's floor windows); the streams property fails."
			}
		]
	}
)

export const shrunkDraws = property.explore(
	(source) => ({ threshold: source.draw(int(1, 500)), seed: source.draw(seeds) }),
	{
		needs: {},
		situations: [],
		check:
			() =>
			({ threshold, seed }) =>
				Effect.gen(function* () {
					const verdict = yield* searchedAt(
						drawsFrom(threshold),
						fullRun("shrunk draws/inner", seed)
					)
					const values = yield* Option.match(
						Option.flatMap(findingOf(verdict), (finding) =>
							finding.kind === "falsified" ? Option.some(finding.token) : Option.none()
						),
						{ onNone: () => Effect.succeedNone, onSome: tokenValues }
					)
					deepStrictEqual(values, Option.some([0, threshold]))
				}),
		oracle: {
			kind: "specification",
			name: "a failure at every draw of at least a threshold shrinks to the threshold itself"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/shrink.ts",
				original: "\t\t\t\t\tif (search.low + 1 >= search.high) {",
				replacement: "\t\t\t\t\tif (search.low + 2 >= search.high) {",
				why: "Lowering a decision by bisection stops one short, above the least value that still fails (shrink-binary-short, re-anchored from shrinkAttempt to shrinkInOrder's bisection); the shrunk draws property fails."
			}
		]
	}
)

export const staleReplays = property.explore(
	(source) => ({
		stale: source.draw(staleCases),
		seed: source.draw(seeds),
		width: source.draw(widths)
	}),
	{
		needs: {},
		situations: STALE_KINDS,
		check:
			(_resources, c) =>
			({ stale: [kind, replayed], seed, width }) =>
				Effect.gen(function* () {
					c.note(kind)
					const id = "stale replay/inner"
					const verdict = yield* replayedAt(
						drawsOnce,
						{ ...fullRun(id, seed), width },
						replayTokenOf(id, replayed)
					)
					strictEqual(verdictKind(verdict), "stale")
				}),
		oracle: {
			kind: "specification",
			name: "a replay that no longer runs exactly as its token says is stale, never passed"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/search.ts",
				original: "\t\t\t\t\t\t\t\t\tranExactly(result, replayed.values.length)",
				replacement: "\t\t\t\t\t\t\t\t\t!result.overrun",
				why: "A replay whose property leaves some of its token's draws over passes, its leftover draws accepted (replay-leftover-accepted, re-anchored from explore.ts to the new search's token run); the stale replay property fails."
			}
		]
	}
)

export const keptNeverWitnesses = property.explore(
	(source) => ({
		value: source.draw(int(0, 9)),
		magic: source.draw(int(2 ** 28, 2 ** 29)),
		seed: source.draw(seeds),
		width: source.draw(widths)
	}),
	{
		needs: {},
		situations: [],
		check:
			() =>
			({ value, magic, seed, width }) =>
				Effect.gen(function* () {
					const id = "kept only/inner"
					const verdict = yield* searchedAt(
						rareByDraw(magic, [
							keptOf(id, { drawn: { kind: "unsteered" }, values: [value, magic] })
						]),
						{ ...fullRun(id, seed), limits: { ...runnerLimits, steered: 0 }, width }
					)
					deepStrictEqual(unreachedOf(verdict), Option.some(["rare"]))
				}),
		oracle: {
			kind: "specification",
			name: "a kept case is no witness: a situation only it reaches is unreached"
		},
		kept: [],
		kills: []
	}
)

export const keptDrawsPrinted = property.explore(
	(source) => ({
		value: source.draw(int(0, 9)),
		draw: source.draw(int(990, 1000)),
		seed: source.draw(seeds)
	}),
	{
		needs: {},
		situations: [],
		check:
			() =>
			({ value, draw, seed }) =>
				Effect.gen(function* () {
					const id = "kept draws/inner"
					const verdict = yield* searchedAt(
						rareDraw([keptOf(id, { drawn: { kind: "unsteered" }, values: [value, draw] })]),
						fullRun(id, seed)
					)
					deepStrictEqual(
						shownOf(verdict),
						Option.some({
							phase: "kept",
							printed: { kind: "drawn", value: String(value), draws: [String(draw)] }
						})
					)
				}),
		oracle: {
			kind: "specification",
			name: "a kept case replays its property's own draws and its failure prints them"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/case.ts",
				original: "\tdraws: Arr.map(drew, (draw) => Formatter.format(draw))",
				replacement: "\tdraws: []",
				why: "A case's printed form leaves out what its property drew, so a kept case's failure no longer shows the draws its token replays (kept-draws-unprinted, re-anchored from explore.ts's kept report to case.ts printedOf); the kept draws property fails."
			}
		]
	}
)

export const keptStale = property.explore(
	(source) => ({
		value: source.draw(int(0, 9)),
		ranOut: source.draw(boolean),
		over: source.draw(int(0, 989)),
		extra: source.draw(int(0, 9)),
		seed: source.draw(seeds)
	}),
	{
		needs: {},
		situations: ["draws run out", "draws left over"],
		check:
			(_resources, c) =>
			({ value, ranOut, over, extra, seed }) =>
				Effect.gen(function* () {
					const id = "stale kept/inner"
					const values = ranOut ? [value] : [value, over, extra]
					c.note(ranOut ? "draws run out" : "draws left over")
					const verdict = yield* searchedAt(
						rareDraw([keptOf(id, { drawn: { kind: "unsteered" }, values })]),
						fullRun(id, seed)
					)
					deepStrictEqual(staleOf(verdict), Option.some("kept"))
				}),
		oracle: {
			kind: "specification",
			name: "a kept case whose draws run out or are left over is stale, never filled in"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/search.ts",
				original: '\t\tchooser: { kind: "forced", values: Float64Array.from(replayed.values) },',
				replacement:
					'\t\tchooser: { kind: "prefix", values: Float64Array.from(replayed.values), rest: { kind: "simplest" } },',
				why: "A token's case whose draws run out is filled in with simplest values, not failed as stale (kept-ran-out-filled, re-anchored from explore.ts's kept chooser to the new search's token order); the stale kept property fails."
			}
		]
	}
)

export const keptObservations = property.explore(
	(source) => ({
		value: source.draw(int(0, 9)),
		decided: [
			source.draw(string(characterOf(["a", "b", " "]), { min: 0, max: 6 })),
			source.draw(string(characterOf(["a", "b", " "]), { min: 0, max: 6 }))
		] as const,
		seed: source.draw(seeds)
	}),
	{
		needs: {},
		situations: [],
		check:
			() =>
			({ value, decided, seed }) =>
				Effect.gen(function* () {
					const id = "kept observations/inner"
					const verdict = yield* searchedAt(
						observing(decided, [keptOf(id, { drawn: { kind: "unsteered" }, values: [value] })]),
						fullRun(id, seed)
					)
					strictEqual(verdictKind(verdict), "explored")
				}),
		oracle: {
			kind: "specification",
			name: "a decision of the system under test is recorded beside the case's draws, never counted as one"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/source.ts",
				original: "\t\tobserve: (value) => {",
				replacement:
					'\t\tobserve: (value) => {\n\t\t\tif (chooser.exhausted(length) && status === "complete") {\n\t\t\t\tstatus = "overrun"\n\t\t\t}',
				why: "An observation past a kept case's draws counts as a draw that ran out, so a kept case that observes is stale; the observations property fails."
			}
		]
	}
)

/** A drawn inner search's limits for the steering property: its rotating runs, floor and window. */
type PhaseShape = Readonly<{
	runs: number
	floor: number
	window: number
	kept: number
	seed: number
}>

export const steeringPhases = property.explore(
	(source): PhaseShape => ({
		runs: source.draw(int(0, 48)),
		floor: source.draw(int(1, 12)),
		window: source.draw(int(1, 16)),
		kept: source.draw(int(0, 9)),
		seed: source.draw(seeds)
	}),
	{
		needs: {},
		situations: ["no rotating case", "a floor past its first window", "a rotating failure"],
		check: (_resources, c) => (shape) =>
			Effect.gen(function* () {
				const id = "steering phases/inner"
				const limits = {
					runs: shape.runs,
					floor: shape.floor,
					steered: runnerLimits.steered,
					window: shape.window,
					deadline: runnerLimits.deadline,
					open: runnerLimits.open
				}
				const inner = aimRecorder([
					keptOf(id, { drawn: { kind: "unsteered" }, values: [shape.kept] })
				])
				yield* searchedAt(inner.property, { ...fullRun(id, shape.seed), limits })
				const aimedFloor = Math.min(shape.window, shape.floor)
				if (shape.floor > shape.window) {
					c.note("a floor past its first window")
				}
				deepStrictEqual(inner.aims, [
					false,
					...copiesOf(true, aimedFloor),
					...copiesOf(false, shape.floor - aimedFloor),
					...copiesOf(false, shape.runs)
				])
				if (shape.runs === 0) {
					c.note("no rotating case")
					return
				}
				c.note("a rotating failure")
				const rotating = yield* searchedAt(failsAfter(shape.floor), {
					...fullRun(id, shape.seed),
					limits
				})
				const drawn = yield* Option.match(
					Option.flatMap(findingOf(rotating), (finding) =>
						finding.kind === "falsified" && finding.phase === "independent"
							? Option.some(finding.token)
							: Option.none()
					),
					{ onNone: () => Effect.succeedNone, onSome: tokenDrawn }
				)
				deepStrictEqual(drawn, Option.some({ kind: "unsteered" }))
			}),
		oracle: {
			kind: "specification",
			name: "an aim draws a case only while its situation is pending as its floor or steered window begins; a kept case and a rotating one are drawn unsteered"
		},
		kept: [],
		kills: []
	}
)

export const exhaustsEverything = property.explore(
	(source): SpaceShape => ({
		a: source.draw(int(1, 4)),
		b: source.draw(int(1, 4)),
		c: source.draw(int(1, 3)),
		width: source.draw(widths),
		deadline: source.draw(int(1, 20))
	}),
	{
		needs: {},
		situations: [
			"a space run whole",
			"a space run whole, sketches at once",
			"property draws enumerated",
			"a space too large to count"
		],
		check: (_resources, k) => (shape) =>
			Effect.gen(function* () {
				const space = shape.a * shape.b * shape.c
				const id = "exhaustive spaces/inner"
				if (shape.c > 1) {
					k.note("property draws enumerated")
				}
				k.note(shape.width > 1 ? "a space run whole, sketches at once" : "a space run whole")
				const pairs = pairsOf(shape)
				const exhausted = yield* searchedAt(pairs.property, {
					...fullRun(id, 0),
					width: shape.width
				})
				deepStrictEqual(
					{
						cases: exhausted.kind === "exhausted" ? exhausted.cases : -1,
						ran: pairs.ran(),
						distinct: pairs.seen.size
					},
					{ cases: space, ran: space, distinct: space }
				)
				k.note("a space too large to count")
				const uncounted = endless()
				const counted = yield* searchedAt(uncounted.property, {
					...fullRun(id, 0),
					limits: { ...runnerLimits, deadline: shape.deadline },
					width: shape.width
				})
				deepStrictEqual(
					{ verdict: verdictKind(counted), ran: uncounted.ran() },
					{ verdict: "uncountable", ran: 0 }
				)
			}),
		oracle: {
			kind: "specification",
			name: "a space of a × b values whose property draws one of c more holds a·b·c cases, each run once at any width; a space too large to count within the case deadline fails, uncountable, with no case run"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/search.ts",
				original:
					'\t\t\t\treturn failed({ kind: "uncountable", box, deadline: run.limits.deadline })',
				replacement: '\t\t\t\treturn { kind: "exhausted", cases: 0, box, measures: [] }',
				why: "An exhaustion reads a space it could not count within the case deadline as a pass, with no case run (exhaust-deadline-passed, re-anchored from explore.ts's test-deadline cut to the new search's uncountable space); the exhaustive spaces property fails."
			},
			{
				file: "packages/testing/src/runner/sketches.ts",
				original: "Option.exists(decisions, (drawn) => branch.length > drawn)",
				replacement: "Option.exists(decisions, (drawn) => branch.length >= drawn)",
				why: "A sketch's run ends one decision late, so it runs on into the next sketch's first case, which runs twice (exhaust-sketch-ends-one-decision-late, re-anchored from explore.ts to the search's rounds of sketches, which a run of sketches now runs on its process, sketches.ts sketchesRun); the exhaustive spaces property fails."
			}
		]
	}
)

export const exhaustAtAnyWidth = property.explore(widthSketches, {
	needs: {},
	situations: ["exhausted", "falsified", "several failing values"],
	check: (_resources, k) => (sketch) =>
		Effect.gen(function* () {
			const id = "exhaust at any width/inner"
			const one = yield* searchedAt(sketchExhaustion(sketch), fullRun(id, 0))
			const many = yield* searchedAt(sketchExhaustion(sketch), {
				...fullRun(id, 0),
				width: sketch.width
			})
			deepStrictEqual(many, one)
			k.note(one.kind === "exhausted" ? "exhausted" : "falsified")
			if (sketch.failing.length > 1) {
				k.note("several failing values")
			}
		}),
	oracle: {
		kind: "specification",
		name: "one case at a time is the definition: every case runs in enumeration order"
	},
	kept: [],
	kills: []
})

export const coverageVerdict = property.explore(verdictSketches, {
	needs: {},
	situations: ["met by the floor", "unreachable", "left to the steered phase"],
	check: (_resources, c) => (sketch) =>
		Effect.gen(function* () {
			const [first, second] = sketch.runs
			const one = yield* witnessRun(sketch, first)
			const other = yield* witnessRun(sketch, second)
			deepStrictEqual(other, one)
			const limits = witnessLimits(sketch.budget)
			const verdict = one.verdict
			switch (floorDecides(sketch)) {
				case "met":
					c.note("met by the floor")
					deepStrictEqual(
						verdict.kind === "explored" ? Option.some(verdict.steered) : Option.none(),
						Option.some(0)
					)
					break
				case "unreachable":
					c.note("unreachable")
					deepStrictEqual(
						findingOf(verdict),
						Option.some({
							kind: "unreached",
							missing: ["rare"],
							witnessed: { kind: "streams", floor: limits.floor, steered: sketch.budget }
						})
					)
					break
				case "steered":
					c.note("left to the steered phase")
					deepStrictEqual(
						verdict.kind === "explored"
							? verdict.steered >= 1 && verdict.steered <= sketch.budget
							: Option.exists(
									findingOf(verdict),
									(finding) =>
										finding.kind === "unreached" &&
										Arr.isReadonlyArrayNonEmpty(finding.missing) &&
										finding.missing.length === 1 &&
										finding.witnessed.kind === "streams" &&
										finding.witnessed.steered === sketch.budget
								),
						true
					)
					break
			}
		}),
	oracle: {
		kind: "universal",
		name: "metamorphic: the coverage verdict and its witnesses are unchanged under another run seed and another width"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/search.ts",
			original: "\t\t\t\tconst stream = steeredSeed(floor)",
			replacement: '\t\t\t\tconst stream = steeredSeed(floorSeed(run.id + " " + String(run.seed)))',
			why: "The steered phase's stream is drawn from the run's seed, so the coverage verdict and its witnesses move with the seed (coverage-verdict-run-seeded, re-anchored from explore.ts to the new search's steered stream); the coverage verdict property fails."
		}
	]
})

export const aimedCase = property.explore(aimedSketches, {
	needs: {},
	situations: [],
	check: () => (sketch) =>
		Effect.gen(function* () {
			const run = { ...fullRun(sketch.label, 0), width: sketch.width }
			const printed = printedNumber(sketch.aimedAt)
			const found = yield* searchedAt(aimedSearch(sketch, []), run)
			deepStrictEqual(shownOf(found), Option.some({ phase: "floor", printed }))
			const failed = falsifiedOf(found)
			if (Option.isNone(failed)) {
				return
			}
			const token = failed.value.token
			const replayed = yield* replayedAt(aimedSearch(sketch, []), run, token)
			const kept = yield* searchedAt(
				aimedSearch(sketch, [
					{ token: ReplayToken(token), reason: "the printed case", since: "2026-11-16" }
				]),
				run
			)
			deepStrictEqual(
				[shownOf(replayed), shownOf(kept)],
				[Option.some({ phase: "replayed", printed }), Option.some({ phase: "kept", printed })]
			)
		}),
	oracle: {
		kind: "universal",
		name: "one case: the case an aim drew is the one run, printed, replayed and kept"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/case.ts",
			original: "\t\t\tprintedOf(drawing.print, drawn.value, closed.drew)\n\t\t)",
			replacement:
				'\t\t\tprintedOf(\n\t\t\t\tdrawing.print,\n\t\t\t\tdrawing.spaceUnder(Option.none())(\n\t\t\t\t\trecording(chooserOf({ kind: "forced", values: drawn.recorded.tape().values.subarray(0, drawn.recorded.tape().length) })).source\n\t\t\t\t),\n\t\t\t\tclosed.drew\n\t\t\t)\n\t\t)',
			why: "A case's report prints the unsteered draw of its tape, not the case its aim drew and ran (aimed-case-reported-unsteered, re-anchored from explore.ts's sketch to case.ts's printed form); the aimed case property fails."
		}
	]
})

export const replayFidelity = property.explore(fidelitySketches, {
	needs: {},
	situations: ["floor", "steered", "independent", "exhaustive"],
	check: (_resources, c: Case<CasePhase>) => (sketch) =>
		Effect.gen(function* () {
			const [first, second] = sketch.runs
			const inner = fidelitySearch(sketch, [])
			const found = yield* searchedAt(inner, fidelityRun(sketch, first))
			const atOtherWidth = yield* searchedAt(
				inner,
				fidelityRun(sketch, { seed: first.seed, width: second.width })
			)
			const failure = caseOf(found)
			deepStrictEqual(caseOf(atOtherWidth), failure)
			if (Option.isNone(failure)) {
				return
			}
			const [phase, token] = failure.value
			c.note(phase)
			if (phase !== "independent") {
				const atOtherSeed = yield* searchedAt(
					inner,
					fidelityRun(sketch, { seed: second.seed, width: first.width })
				)
				deepStrictEqual(caseOf(atOtherSeed), failure)
			}
			const replayed = yield* replayedAt(inner, fidelityRun(sketch, second), token)
			const kept = yield* searchedAt(
				fidelitySearch(sketch, [
					{ token: ReplayToken(token), reason: "the failure", since: "2026-11-16" }
				]),
				fidelityRun(sketch, second)
			)
			deepStrictEqual(
				[caseOf(replayed), caseOf(kept)],
				[Option.some(["replayed", token] as const), Option.some(["kept", token] as const)]
			)
		}),
	oracle: {
		kind: "universal",
		name: "round trip: a failure's replay token reruns the same case under the same steering"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/search.ts",
			original: '\t\tdrawn: replayed.drawn,\n\t\tkeep: "nothing",',
			replacement: '\t\tdrawn: { kind: "unsteered" },\n\t\tkeep: "nothing",',
			why: "A replay runs its case unsteered, whatever steering its token records (replay-unsteered, re-anchored from explore.ts to the new search's token order); the replay fidelity property fails."
		}
	]
})

export const ownBudget = property.explore(
	(source) => ({
		runs: source.draw(int(0, 60)),
		steered: source.draw(int(0, 40)),
		seed: source.draw(seeds),
		width: source.draw(widths)
	}),
	{
		needs: {},
		situations: [],
		check: () => (shape) =>
			Effect.gen(function* () {
				const inner = property.explore(int(0, 9), {
					needs: {},
					situations: ["never noted"],
					check: () => () => Effect.void,
					oracle: { kind: "specification", name: "a property that states its own budget" },
					kept: [],
					kills: [],
					budget: { runs: shape.runs, steered: shape.steered }
				})
				const passingInner = property.explore(int(0, 9), {
					needs: {},
					situations: [],
					check: () => () => Effect.void,
					oracle: { kind: "specification", name: "a property that states its own budget" },
					kept: [],
					kills: [],
					budget: { runs: shape.runs, steered: shape.steered }
				})
				const run = { ...fullRun("own budget/inner", shape.seed), width: shape.width }
				const unreached = yield* searchedAt(inner, run)
				const passed = yield* searchedAt(passingInner, run)
				deepStrictEqual(
					{
						witnessed: Option.map(findingOf(unreached), (finding) =>
							finding.kind === "unreached" && finding.witnessed.kind === "streams"
								? { floor: finding.witnessed.floor, steered: finding.witnessed.steered }
								: { floor: -1, steered: -1 }
						),
						rotating: passed.kind === "explored" ? passed.residual.cases : -1
					},
					{
						witnessed: Option.some({ floor: Math.ceil(shape.runs / 4), steered: shape.steered }),
						rotating: shape.runs
					}
				)
			}),
		oracle: {
			kind: "specification",
			name: "a property's own budget replaces the runner's: its floor a quarter of its runs rounded up, its steered phase its own count"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/property.ts",
				original:
					"\t\t\tfloor: cited.budget === undefined ? run.limits.floor : floorOf(cited.budget.runs),",
				replacement: "\t\t\tfloor: run.limits.floor,",
				why: "A property's own runs leave its floor at the runner's, so a property that restores its suite's old count of cases still runs the runner's floor of witnesses; this property fails."
			},
			{
				file: "packages/testing/src/property.ts",
				original: "\t\t\truns: cited.budget?.runs ?? run.limits.runs,",
				replacement: "\t\t\truns: run.limits.runs,",
				why: "A property's own runs are ignored, so its rotating stream runs the runner's count, however many cases its suite stated before; this property fails."
			},
			{
				file: "packages/testing/src/property.ts",
				original: "\t\t\tsteered: cited.budget?.steered ?? run.limits.steered",
				replacement: "\t\t\tsteered: run.limits.steered",
				why: "A property's own steered count is ignored, so its steered phase runs the runner's budget; this property fails."
			}
		]
	}
)
