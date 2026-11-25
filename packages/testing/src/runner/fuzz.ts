import { Array as Arr, Console, Effect, Option, Random, Schema } from "effect"
import { budgetOf, FuzzTime, spent } from "#fuzz.ts"
import { cpuMeter } from "#live.ts"
import { runNeedsOf } from "#property.ts"
import { sharedStore } from "#runner/compile-cache.ts"
import { workerEnvironmentOf } from "#runner/environment.ts"
import { needStallMillis, runnerLimits } from "#runner/limits.ts"
import { placesOf, poolOf } from "#runner/pool.ts"
import type { Verdict } from "#runner/protocol.ts"
import { failureLines, lineOf } from "#runner/report.ts"
import { loadPackage, WORKER_ENTRY } from "#runner/run.ts"
import { openedRuns } from "#runner/runs.ts"
import { testWorkers } from "#workers.ts"

/**
 * `toolchain-test fuzz <fuzztime> [paths | property ids]`, the scheduled fuzz budget: the package's sampled properties
 * (every kind but an exhaustion, whose every case a run already checks), or those named, searched round after round at
 * reach `rotating`, each round under a fresh run seed, so each round is new cases alone (a property's kept tokens, floor
 * and steered phase are the same on every seed, and every run and push already checks them), until a case fails or
 * the budget is spent. The budget is Go's `-fuzztime`, which the scheduler that runs the command states: `30m` or `2h`
 * of the run's CPU (its own, its workers' and their children's: live.ts cpuMeter, begun before its pool forks a worker),
 * never of wall time, so it reaches the same cases however loaded the machine is; or `100000x` cases, checked after
 * each round. It never reads or writes the verdict cache and never runs
 * in the push gate: a failure prints the round's TEST_SEED, which `toolchain-test run` reproduces, and each failing
 * case's replay token.
 *
 * The schedule is the consumer's: its own scheduler (a crontab line, a CI schedule) runs the command in each package
 * root that has a test.config.ts, for example nightly `cd <package> && pnpm exec toolchain-test fuzz 1h`. The toolchain
 * adds no scheduler.
 */

/** The fuzz command could not run: its usage. */
class FuzzRefused extends Schema.TaggedError<FuzzRefused, { readonly brand: unique symbol }>()(
	"FuzzRefused",
	{ message: Schema.String }
) {}

/** The cases a verdict ran. */
const casesOf = (verdict: Verdict): number => {
	switch (verdict.kind) {
		case "explored":
		case "exhausted":
			return verdict.cases
		case "replayed":
		case "failed":
			return 0
	}
}

/** `fuzz <fuzztime> [paths | ids]` in the package at `root`: 1 when a case fails, 0 when the budget is spent. */
export const fuzz = (root: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const [fuzzTime, ...selected] = args
			const budget = yield* Effect.mapBoth(Schema.decodeUnknownEffect(FuzzTime)(fuzzTime), {
				onFailure: () =>
					FuzzRefused.make({
						message:
							"fuzz takes its budget first, as Go's -fuzztime writes it (30m, 2h, 100000x): toolchain-test fuzz <fuzztime> [paths | ids]"
					}),
				onSuccess: budgetOf
			})
			const { config, discovered } = yield* loadPackage(root, selected)
			const sampled = Arr.filter(discovered, (found) => found.property.kind !== "exhaust")
			if (!Arr.isReadonlyArrayNonEmpty(sampled)) {
				yield* Console.log("no sampled property to fuzz")
				return 0
			}
			const cpuSince = yield* cpuMeter
			const pool = yield* poolOf({
				entry: WORKER_ENTRY,
				root,
				cwd: root,
				env: workerEnvironmentOf(config.environment, process.env),
				compile: sharedStore,
				places: placesOf(testWorkers),
				execArgv: process.execArgv,
				served: Option.none(),
				guide: Arr.some(sampled, (found) => found.property.guide.kind === "blocks")
					? "blocks"
					: "notes",
				runs: yield* openedRuns(
					runNeedsOf(Arr.map(sampled, (found) => found.property.needs)),
					root,
					needStallMillis
				),
				stall: needStallMillis,
				bounding: "summed"
			})
			let rounds = 0
			let cases = 0
			for (;;) {
				const seed = yield* Random.nextIntBetween(0, 0xffff_ffff)
				const verdicts = yield* Effect.forEach(
					sampled,
					(found) =>
						Effect.map(
							found.property.search({
								id: found.id,
								seed,
								limits: runnerLimits,
								evaluator: pool.evaluator,
								reach: "rotating"
							}),
							(verdict) => ({ found, verdict })
						),
					{ concurrency: "unbounded" }
				)
				rounds += 1
				cases += Arr.reduce(verdicts, 0, (sum, { verdict }) => sum + casesOf(verdict))
				const failed = Arr.filter(verdicts, ({ verdict }) => verdict.kind === "failed")
				if (Arr.isReadonlyArrayNonEmpty(failed)) {
					yield* Console.log(
						Arr.join(
							[
								`TEST_SEED=${seed} (round ${rounds}; toolchain-test run with it reproduces the round)`,
								...Arr.map(failed, ({ found, verdict }) =>
									lineOf(found.id, found.property.oracle, verdict)
								),
								...Arr.flatMap(failed, ({ found, verdict }) => [
									"",
									`${found.id}:`,
									...failureLines(verdict)
								])
							],
							"\n"
						)
					)
					return 1
				}
				const cpu = yield* cpuSince
				if (spent(budget, cases, cpu)) {
					yield* Console.log(
						`${sampled.length} properties fuzzed: ${rounds} rounds, ${cases} cases, in ${Math.round(cpu)} ms of CPU, no case failed`
					)
					return 0
				}
			}
		})
	)
