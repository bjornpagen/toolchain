import { Duration, Effect, Formatter, Option } from "effect"
import { drawn, explore, Run } from "#explore.ts"
import { noCoverage } from "#features.ts"
import { int } from "#gen.ts"
import { INNER_SEED } from "#runner/work.fixtures.ts"
import { boundedShrink } from "#shrink.ts"

/**
 * How a search whose case, whatever its value, does `work` ends under a hang limit of `hang` milliseconds (explore.ts
 * explore, as `searched` runs a Vitest suite's search): `explored`, `hung: ` and its hang report, or `failed: ` and its
 * failure. It runs its floor stream's one case and no rotating case, in this process, under the runner's inner seed
 * (runner/work.fixtures.ts INNER_SEED), and shrinks nothing.
 */
export const searchedOnce = (work: Effect.Effect<void>, hang: number): Effect.Effect<string> =>
	explore(
		{
			suite: "explore/guard",
			oracle: { kind: "specification", name: "a planted case of a search's guard" },
			draw: drawn(int(0, 9)),
			literal: Formatter.format,
			coverage: noCoverage,
			kept: [],
			runs: 0,
			shrink: boundedShrink(0),
			steerEvery: 1,
			caseHang: Duration.millis(hang)
		},
		() => work
	).pipe(
		Effect.provideService(
			Run,
			Run.of({
				seed: INNER_SEED,
				source: "environment",
				replay: Option.none(),
				fuzz: Option.none()
			})
		),
		Effect.map((done): string => done.kind),
		Effect.catchTag("CaseHung", (hung) => Effect.succeed(`hung: ${hung.message}`)),
		Effect.catch((failure) => Effect.succeed(`failed: ${failure._tag}: ${failure.message}`))
	)
