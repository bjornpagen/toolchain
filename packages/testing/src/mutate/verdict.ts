/**
 * What judges a kill once its trial went red, whoever runs the trial: the kill gate, a property's witnesses on its
 * pool's workers (mutate/kills.ts killsOf), or a consumer's own trials, run under this process's guard on work
 * (live.ts withinBound). A red is the kill's, but one the trial's bound brought about, which the machine's load can
 * bring about as well as a mutant, is the kill's only when the baseline, run again at once with no mutant under the
 * same bound, passes.
 */
import { Effect, Option } from "effect"

/**
 * Why a kill is unjudged. `red with no mutant`: its property's baseline, its witnesses with no mutant, went red before
 * any of its kills was tried (a need the run's width cannot serve, workers that cannot start). `the baseline overran
 * too`: the kill's trial went red only because its bound ended it (the pool's, protocol.ts LostBy, or a consumer's
 * guard), and its baseline, run again at once under the same bound, went red too, so the overrun is the machine's
 * load, not the mutant's.
 */
export type Unjudged = "red with no mutant" | "the baseline overran too"

/**
 * Why a kill is unjudged, on one line, with `red`, the red of its property's baseline as its runner states it on one
 * line (mutate/kills.ts redText).
 */
export const unjudgedText = (why: Unjudged, red: string): string => {
	switch (why) {
		case "red with no mutant":
			return `the property goes red with no mutant (${red})`
		case "the baseline overran too":
			return `the kill's trial was ended by its bound, and the baseline overran too: run again at once with no mutant, under the same bound, the property went red (${red})`
	}
}

/** A red trial's verdict, its red as its runner states it (`R`): killed, or unjudged and why (Unjudged). */
export type RedVerdict<R> =
	| Readonly<{ kind: "killed"; red: R }>
	| Readonly<{ kind: "unjudged"; red: R; why: Unjudged }>

/**
 * A kill's verdict once its trial went red (`red`), which is the kill's, but when its bound ended the trial
 * (`overran`): then `again`, its baseline run again at once under the same bound, judges it, answering the baseline's
 * red, or none when it passed. The kill is unjudged when the baseline went red too, with the baseline's red, and killed
 * when it passed.
 */
export const verdictOfRed = <R, E, Q>(
	red: R,
	overran: boolean,
	again: Effect.Effect<Option.Option<R>, E, Q>
): Effect.Effect<RedVerdict<R>, E, Q> =>
	overran
		? Effect.map(again, (baseline) =>
				Option.match(baseline, {
					onNone: (): RedVerdict<R> => ({ kind: "killed", red }),
					onSome: (its): RedVerdict<R> => ({
						kind: "unjudged",
						red: its,
						why: "the baseline overran too"
					})
				})
			)
		: Effect.succeed({ kind: "killed", red })
